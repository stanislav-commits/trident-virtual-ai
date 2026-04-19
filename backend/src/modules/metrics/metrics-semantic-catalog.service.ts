import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { CreateMetricConceptDto } from './dto/create-metric-concept.dto';
import { ResolveMetricConceptDto } from './dto/resolve-metric-concept.dto';
import { UpdateMetricConceptDto } from './dto/update-metric-concept.dto';
import { MetricConceptAliasEntity } from './entities/metric-concept-alias.entity';
import { MetricConceptEntity } from './entities/metric-concept.entity';
import { MetricConceptMemberEntity } from './entities/metric-concept-member.entity';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { MetricAggregationRule } from './enums/metric-aggregation-rule.enum';

interface MetricConceptMemberResponseDto {
  id: string;
  role: string | null;
  sortOrder: number;
  metricCatalogId: string | null;
  childConceptId: string | null;
  metric:
    | {
        id: string;
        shipId: string;
        key: string;
        bucket: string;
        field: string;
        description: string | null;
      }
    | null;
  childConcept:
    | {
        id: string;
        slug: string;
        displayName: string;
      }
    | null;
}

export interface MetricConceptResponseDto {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  category: string | null;
  type: string;
  aggregationRule: MetricAggregationRule;
  unit: string | null;
  isActive: boolean;
  aliases: string[];
  members: MetricConceptMemberResponseDto[];
  createdAt: string;
  updatedAt: string;
}

export interface MetricConceptResolutionCandidateDto {
  concept: MetricConceptResponseDto;
  score: number;
  matchReason: string;
}

export interface MetricConceptResolutionDto {
  query: string;
  normalizedQuery: string;
  resolvedConcept: MetricConceptResponseDto | null;
  candidates: MetricConceptResolutionCandidateDto[];
}

@Injectable()
export class MetricsSemanticCatalogService {
  constructor(
    @InjectRepository(MetricConceptEntity)
    private readonly metricConceptRepository: Repository<MetricConceptEntity>,
    @InjectRepository(MetricConceptAliasEntity)
    private readonly metricConceptAliasRepository: Repository<MetricConceptAliasEntity>,
    @InjectRepository(MetricConceptMemberEntity)
    private readonly metricConceptMemberRepository: Repository<MetricConceptMemberEntity>,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly shipMetricCatalogRepository: Repository<ShipMetricCatalogEntity>,
  ) {}

  async listConcepts(): Promise<MetricConceptResponseDto[]> {
    const concepts = await this.metricConceptRepository.find({
      relations: {
        aliases: true,
        members: {
          metricCatalog: true,
          childConcept: true,
        },
      },
      order: {
        slug: 'ASC',
        aliases: {
          alias: 'ASC',
        },
        members: {
          sortOrder: 'ASC',
          createdAt: 'ASC',
        },
      },
    });

    return concepts.map((concept) => this.serializeConcept(concept));
  }

  async createConcept(
    input: CreateMetricConceptDto,
  ): Promise<MetricConceptResponseDto> {
    const slug = this.normalizeSlug(input.slug);
    await this.assertSlugAvailable(slug);

    const concept = this.metricConceptRepository.create({
      slug,
      displayName: input.displayName.trim(),
      description: this.normalizeOptionalText(input.description),
      category: this.normalizeOptionalText(input.category),
      type: input.type,
      aggregationRule: input.aggregationRule ?? MetricAggregationRule.NONE,
      unit: this.normalizeOptionalText(input.unit),
      isActive: input.isActive ?? true,
    });

    const savedConcept = await this.metricConceptRepository.save(concept);
    await this.replaceAliases(savedConcept.id, input.aliases ?? []);
    await this.replaceMembers(savedConcept.id, input.members ?? []);
    return this.getRequiredConcept(savedConcept.id);
  }

  async updateConcept(
    conceptId: string,
    input: UpdateMetricConceptDto,
  ): Promise<MetricConceptResponseDto> {
    const concept = await this.metricConceptRepository.findOne({
      where: { id: conceptId },
    });

    if (!concept) {
      throw new NotFoundException('Metric concept not found');
    }

    if (input.slug) {
      const normalizedSlug = this.normalizeSlug(input.slug);

      if (normalizedSlug !== concept.slug) {
        await this.assertSlugAvailable(normalizedSlug, concept.id);
        concept.slug = normalizedSlug;
      }
    }

    if (typeof input.displayName === 'string') {
      concept.displayName = input.displayName.trim();
    }

    if (input.description !== undefined) {
      concept.description = this.normalizeOptionalText(input.description);
    }

    if (input.category !== undefined) {
      concept.category = this.normalizeOptionalText(input.category);
    }

    if (input.type !== undefined) {
      concept.type = input.type;
    }

    if (input.aggregationRule !== undefined) {
      concept.aggregationRule = input.aggregationRule;
    }

    if (input.unit !== undefined) {
      concept.unit = this.normalizeOptionalText(input.unit);
    }

    if (input.isActive !== undefined) {
      concept.isActive = input.isActive;
    }

    await this.metricConceptRepository.save(concept);

    if (input.aliases !== undefined) {
      await this.replaceAliases(concept.id, input.aliases);
    }

    if (input.members !== undefined) {
      await this.replaceMembers(concept.id, input.members);
    }

    return this.getRequiredConcept(concept.id);
  }

  async resolveConcept(
    input: ResolveMetricConceptDto,
  ): Promise<MetricConceptResolutionDto> {
    const normalizedQuery = this.normalizeSearchValue(input.query);

    if (!normalizedQuery) {
      throw new BadRequestException('query must not be empty');
    }

    const concepts = await this.metricConceptRepository.find({
      where: { isActive: true },
      relations: {
        aliases: true,
        members: {
          metricCatalog: true,
          childConcept: true,
        },
      },
      order: {
        slug: 'ASC',
      },
    });

    const candidates = concepts
      .map((concept) => this.scoreConceptMatch(concept, normalizedQuery, input.shipId))
      .filter(
        (
          candidate,
        ): candidate is {
          concept: MetricConceptEntity;
          score: number;
          matchReason: string;
        } => candidate !== null,
      )
      .sort((left, right) => right.score - left.score || left.concept.slug.localeCompare(right.concept.slug))
      .slice(0, 10);

    return {
      query: input.query.trim(),
      normalizedQuery,
      resolvedConcept: candidates[0]
        ? this.serializeConcept(candidates[0].concept)
        : null,
      candidates: candidates.map((candidate) => ({
        concept: this.serializeConcept(candidate.concept),
        score: candidate.score,
        matchReason: candidate.matchReason,
      })),
    };
  }

  private scoreConceptMatch(
    concept: MetricConceptEntity,
    normalizedQuery: string,
    shipId?: string,
  ):
    | {
        concept: MetricConceptEntity;
        score: number;
        matchReason: string;
      }
    | null {
    const candidateValues = [
      {
        value: this.normalizeSearchValue(concept.slug),
        score: 120,
        reason: 'exact_slug',
      },
      {
        value: this.normalizeSearchValue(concept.displayName),
        score: 110,
        reason: 'exact_display_name',
      },
      ...concept.aliases.map((alias) => ({
        value: this.normalizeSearchValue(alias.alias),
        score: 100,
        reason: 'alias',
      })),
    ];

    let bestMatch:
      | {
          score: number;
          reason: string;
        }
      | null = null;

    for (const candidate of candidateValues) {
      if (!candidate.value) {
        continue;
      }

      if (candidate.value === normalizedQuery) {
        bestMatch = {
          score: candidate.score,
          reason: candidate.reason,
        };
        break;
      }

      if (
        candidate.value.includes(normalizedQuery) ||
        normalizedQuery.includes(candidate.value)
      ) {
        bestMatch = {
          score: Math.max(candidate.score - 25, 1),
          reason: `partial_${candidate.reason}`,
        };
      }
    }

    if (!bestMatch) {
      return null;
    }

    const scopedMembers = concept.members.filter((member) => {
      if (!shipId) {
        return true;
      }

      if (!member.metricCatalog) {
        return true;
      }

      return member.metricCatalog.shipId === shipId;
    });

    if (shipId && concept.members.length > 0 && scopedMembers.length === 0) {
      return null;
    }

    return {
      concept: {
        ...concept,
        members: shipId ? scopedMembers : concept.members,
      },
      score: bestMatch.score,
      matchReason: bestMatch.reason,
    };
  }

  private async getRequiredConcept(
    conceptId: string,
  ): Promise<MetricConceptResponseDto> {
    const concept = await this.metricConceptRepository.findOne({
      where: { id: conceptId },
      relations: {
        aliases: true,
        members: {
          metricCatalog: true,
          childConcept: true,
        },
      },
      order: {
        aliases: {
          alias: 'ASC',
        },
        members: {
          sortOrder: 'ASC',
          createdAt: 'ASC',
        },
      },
    });

    if (!concept) {
      throw new NotFoundException('Metric concept not found');
    }

    return this.serializeConcept(concept);
  }

  private async replaceAliases(
    conceptId: string,
    aliases: string[],
  ): Promise<void> {
    await this.metricConceptAliasRepository.delete({ conceptId });

    const normalizedAliases = [...new Set(
      aliases
        .map((alias) => this.normalizeOptionalText(alias))
        .filter((alias): alias is string => Boolean(alias)),
    )];

    if (!normalizedAliases.length) {
      return;
    }

    await this.metricConceptAliasRepository.save(
      normalizedAliases.map((alias) =>
        this.metricConceptAliasRepository.create({
          conceptId,
          alias,
        }),
      ),
    );
  }

  private async replaceMembers(
    conceptId: string,
    members: CreateMetricConceptDto['members'],
  ): Promise<void> {
    await this.metricConceptMemberRepository.delete({ conceptId });

    if (!members?.length) {
      return;
    }

    const metricCatalogIds = members
      .map((member) => member.metricCatalogId)
      .filter((value): value is string => Boolean(value));
    const childConceptIds = members
      .map((member) => member.childConceptId)
      .filter((value): value is string => Boolean(value));

    if (metricCatalogIds.length > 0) {
      const metrics = await this.shipMetricCatalogRepository.find({
        where: { id: In(metricCatalogIds) },
        select: { id: true },
      });

      if (metrics.length !== new Set(metricCatalogIds).size) {
        throw new BadRequestException(
          'One or more metricCatalogId values do not exist',
        );
      }
    }

    if (childConceptIds.length > 0) {
      const childConcepts = await this.metricConceptRepository.find({
        where: { id: In(childConceptIds) },
        select: { id: true },
      });

      if (childConcepts.length !== new Set(childConceptIds).size) {
        throw new BadRequestException(
          'One or more childConceptId values do not exist',
        );
      }
    }

    const preparedMembers = members.map((member, index) => {
      const metricCatalogId = member.metricCatalogId ?? null;
      const childConceptId = member.childConceptId ?? null;

      if (!metricCatalogId && !childConceptId) {
        throw new BadRequestException(
          'Each metric concept member must reference metricCatalogId or childConceptId',
        );
      }

      if (metricCatalogId && childConceptId) {
        throw new BadRequestException(
          'A metric concept member cannot reference both metricCatalogId and childConceptId',
        );
      }

      if (childConceptId === conceptId) {
        throw new BadRequestException(
          'A metric concept cannot include itself as a child concept',
        );
      }

      return this.metricConceptMemberRepository.create({
        conceptId,
        metricCatalogId,
        childConceptId,
        role: this.normalizeOptionalText(member.role),
        sortOrder: member.sortOrder ?? index,
      });
    });

    await this.metricConceptMemberRepository.save(preparedMembers);
  }

  private serializeConcept(
    concept: MetricConceptEntity,
  ): MetricConceptResponseDto {
    return {
      id: concept.id,
      slug: concept.slug,
      displayName: concept.displayName,
      description: concept.description,
      category: concept.category,
      type: concept.type,
      aggregationRule: concept.aggregationRule,
      unit: concept.unit,
      isActive: concept.isActive,
      aliases: [...(concept.aliases ?? [])]
        .map((alias) => alias.alias)
        .sort((left, right) => left.localeCompare(right)),
      members: [...(concept.members ?? [])]
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((member) => ({
          id: member.id,
          role: member.role,
          sortOrder: member.sortOrder,
          metricCatalogId: member.metricCatalogId,
          childConceptId: member.childConceptId,
          metric: member.metricCatalog
            ? {
                id: member.metricCatalog.id,
                shipId: member.metricCatalog.shipId,
                key: member.metricCatalog.key,
                bucket: member.metricCatalog.bucket,
                field: member.metricCatalog.field,
                description: member.metricCatalog.description,
              }
            : null,
          childConcept: member.childConcept
            ? {
                id: member.childConcept.id,
                slug: member.childConcept.slug,
                displayName: member.childConcept.displayName,
              }
            : null,
        })),
      createdAt: concept.createdAt.toISOString(),
      updatedAt: concept.updatedAt.toISOString(),
    };
  }

  private async assertSlugAvailable(
    slug: string,
    ignoreConceptId?: string,
  ): Promise<void> {
    const existing = await this.metricConceptRepository.findOne({
      where: { slug },
      select: { id: true },
    });

    if (existing && existing.id !== ignoreConceptId) {
      throw new BadRequestException(
        `Metric concept slug "${slug}" already exists`,
      );
    }
  }

  private normalizeSlug(value: string): string {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (!normalized) {
      throw new BadRequestException('slug must not be empty');
    }

    return normalized;
  }

  private normalizeOptionalText(value?: string | null): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private normalizeSearchValue(value?: string | null): string {
    return (
      value
        ?.trim()
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ') ?? ''
    ).trim();
  }
}
