import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShipEntity } from '../ships/entities/ship.entity';
import { MetricConceptEntity } from './entities/metric-concept.entity';
import { MetricConceptMemberEntity } from './entities/metric-concept-member.entity';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { MetricAggregationRule } from './enums/metric-aggregation-rule.enum';
import { MetricConceptType } from './enums/metric-concept-type.enum';
import { buildMetricSemanticBlueprint } from './metrics-semantic-bootstrap.utils';

export interface MetricsSemanticBootstrapResultDto {
  ship: {
    id: string;
    name: string;
    organizationName: string | null;
  };
  totalMetrics: number;
  conceptsCreated: number;
  conceptsUpdated: number;
  membersAdded: number;
  skippedBindings: number;
  sampleConcepts: Array<{
    slug: string;
    displayName: string;
  }>;
}

@Injectable()
export class MetricsSemanticBootstrapService {
  constructor(
    @InjectRepository(ShipEntity)
    private readonly shipsRepository: Repository<ShipEntity>,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly shipMetricCatalogRepository: Repository<ShipMetricCatalogEntity>,
    @InjectRepository(MetricConceptEntity)
    private readonly metricConceptRepository: Repository<MetricConceptEntity>,
    @InjectRepository(MetricConceptMemberEntity)
    private readonly metricConceptMemberRepository: Repository<MetricConceptMemberEntity>,
  ) {}

  async bootstrapShipCatalog(
    shipId: string,
  ): Promise<MetricsSemanticBootstrapResultDto> {
    const ship = await this.shipsRepository.findOne({
      where: { id: shipId },
    });

    if (!ship) {
      throw new NotFoundException('Ship not found');
    }

    const metrics = await this.shipMetricCatalogRepository.find({
      where: { shipId },
      order: {
        bucket: 'ASC',
        key: 'ASC',
      },
    });
    const concepts = await this.metricConceptRepository.find({
      relations: {
        members: true,
      },
      order: {
        slug: 'ASC',
      },
    });

    const conceptsBySlug = new Map(concepts.map((concept) => [concept.slug, concept]));
    const metricMembersByConceptId = new Map(
      concepts.map((concept) => [
        concept.id,
        new Set(
          (concept.members ?? [])
            .map((member) => member.metricCatalogId)
            .filter((value): value is string => Boolean(value)),
        ),
      ]),
    );

    let conceptsCreated = 0;
    let conceptsUpdated = 0;
    let membersAdded = 0;
    let skippedBindings = 0;
    const sampleConcepts: Array<{
      slug: string;
      displayName: string;
    }> = [];

    for (const metric of metrics) {
      const blueprint = buildMetricSemanticBlueprint(metric);
      let concept = conceptsBySlug.get(blueprint.slug) ?? null;

      if (!concept) {
        concept = await this.metricConceptRepository.save(
          this.metricConceptRepository.create({
            slug: blueprint.slug,
            displayName: blueprint.displayName,
            description: blueprint.description,
            category: blueprint.category,
            type: MetricConceptType.SINGLE,
            aggregationRule: MetricAggregationRule.LAST,
            unit: blueprint.unit,
            isActive: true,
          }),
        );
        conceptsBySlug.set(concept.slug, {
          ...concept,
          members: [],
        });
        metricMembersByConceptId.set(concept.id, new Set());
        conceptsCreated += 1;
      } else {
        const conceptChanged = this.patchExistingConcept(concept, blueprint);

        if (conceptChanged) {
          concept = await this.metricConceptRepository.save(concept);
          conceptsUpdated += 1;
        }
      }

      const conceptMetricMemberSet =
        metricMembersByConceptId.get(concept.id) ?? new Set<string>();

      if (conceptMetricMemberSet.has(metric.id)) {
        skippedBindings += 1;
      } else {
        await this.metricConceptMemberRepository.save(
          this.metricConceptMemberRepository.create({
            conceptId: concept.id,
            metricCatalogId: metric.id,
            role: 'primary',
            sortOrder: 0,
          }),
        );
        conceptMetricMemberSet.add(metric.id);
        metricMembersByConceptId.set(concept.id, conceptMetricMemberSet);
        membersAdded += 1;
      }

      if (sampleConcepts.length < 20) {
        sampleConcepts.push({
          slug: blueprint.slug,
          displayName: blueprint.displayName,
        });
      }
    }

    return {
      ship: {
        id: ship.id,
        name: ship.name,
        organizationName: ship.organizationName,
      },
      totalMetrics: metrics.length,
      conceptsCreated,
      conceptsUpdated,
      membersAdded,
      skippedBindings,
      sampleConcepts,
    };
  }

  private patchExistingConcept(
    concept: MetricConceptEntity,
    blueprint: ReturnType<typeof buildMetricSemanticBlueprint>,
  ): boolean {
    let changed = false;

    if (concept.displayName !== blueprint.displayName) {
      concept.displayName = blueprint.displayName;
      changed = true;
    }

    if (!concept.description && blueprint.description) {
      concept.description = blueprint.description;
      changed = true;
    }

    if (!concept.category && blueprint.category) {
      concept.category = blueprint.category;
      changed = true;
    }

    if (!concept.unit && blueprint.unit) {
      concept.unit = blueprint.unit;
      changed = true;
    }

    if (!concept.isActive) {
      concept.isActive = true;
      changed = true;
    }

    if (concept.type !== MetricConceptType.SINGLE) {
      return changed;
    }

    if (concept.aggregationRule !== MetricAggregationRule.LAST) {
      concept.aggregationRule = MetricAggregationRule.LAST;
      changed = true;
    }

    return changed;
  }
}
