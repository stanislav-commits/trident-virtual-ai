import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InfluxMetricSample,
  InfluxMetricSelector,
  InfluxService,
} from '../../integrations/influx/influx.service';
import { ShipEntity } from '../ships/entities/ship.entity';
import { ExecuteMetricConceptDto } from './dto/execute-metric-concept.dto';
import { MetricConceptEntity } from './entities/metric-concept.entity';
import { MetricConceptMemberEntity } from './entities/metric-concept-member.entity';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { MetricAggregationRule } from './enums/metric-aggregation-rule.enum';
import { MetricConceptType } from './enums/metric-concept-type.enum';
import { MetricQueryTimeMode } from './enums/metric-query-time-mode.enum';
import { buildMetricSemanticBlueprint } from './metrics-semantic-bootstrap.utils';
import { MetricsSemanticCatalogService } from './metrics-semantic-catalog.service';

interface MetricConceptRuntimeNode {
  concept: MetricConceptEntity;
  members: MetricConceptMemberEntity[];
}

interface MetricConceptExecutionMemberDto {
  memberId: string;
  role: string | null;
  sourceType: 'metric';
  metricCatalogId: string;
  label: string;
  key: string | null;
  value: unknown;
  unit: string | null;
  timestamp: string | null;
  description: string | null;
  result: null;
}

interface MetricConceptExecutionResultDto {
  conceptId: string;
  conceptSlug: string;
  conceptDisplayName: string;
  type: MetricConceptType;
  aggregationRule: MetricAggregationRule;
  value: unknown;
  unit: string | null;
  timestamp: string | null;
  members: MetricConceptExecutionMemberDto[];
  metadata: Record<string, unknown> | null;
}

export interface MetricConceptExecutionResponseDto {
  query: string | null;
  ship: {
    id: string;
    name: string;
    organizationName: string | null;
  };
  concept: {
    id: string;
    slug: string;
    displayName: string;
    description: string | null;
    category: string | null;
    type: MetricConceptType;
    aggregationRule: MetricAggregationRule;
    unit: string | null;
  };
  timeMode: MetricQueryTimeMode;
  timestamp: string | null;
  queriedMetricCount: number;
  result: MetricConceptExecutionResultDto;
}

@Injectable()
export class MetricsConceptExecutionService {
  constructor(
    @InjectRepository(MetricConceptEntity)
    private readonly metricConceptRepository: Repository<MetricConceptEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipsRepository: Repository<ShipEntity>,
    private readonly metricsSemanticCatalogService: MetricsSemanticCatalogService,
    private readonly influxService: InfluxService,
  ) {}

  async execute(
    input: ExecuteMetricConceptDto,
  ): Promise<MetricConceptExecutionResponseDto> {
    const ship = await this.resolveShip(input.shipId);
    const timeMode = input.timeMode ?? MetricQueryTimeMode.SNAPSHOT;
    const timestamp = this.resolveTimestamp(timeMode, input.timestamp);
    const concept = await this.resolveRuntimeConcept(
      {
        conceptId: input.conceptId,
        query: input.query,
      },
      ship.id,
    );

    const leafMetrics = this.collectLeafMetrics(concept);

    if (!leafMetrics.length) {
      throw new BadRequestException(
        'The concept has no metric bindings for the selected ship',
      );
    }

    if (!ship.organizationName?.trim()) {
      throw new BadRequestException(
        'Ship organization is required to query Influx metrics',
      );
    }

    const samples = await this.fetchMetricSamples(
      ship.organizationName,
      leafMetrics,
      timeMode,
      timestamp,
    );
    const result = this.buildExecutionResult(concept, samples);

    return {
      query: input.query?.trim() ?? null,
      ship: {
        id: ship.id,
        name: ship.name,
        organizationName: ship.organizationName,
      },
      concept: this.serializeConceptSummary(concept.concept),
      timeMode,
      timestamp: timestamp?.toISOString() ?? null,
      queriedMetricCount: samples.size,
      result,
    };
  }

  private async resolveShip(shipId?: string): Promise<ShipEntity> {
    if (!shipId) {
      throw new BadRequestException('shipId is required');
    }

    const ship = await this.shipsRepository.findOne({
      where: { id: shipId },
    });

    if (!ship) {
      throw new NotFoundException('Ship not found');
    }

    return ship;
  }

  private resolveTimestamp(
    timeMode: MetricQueryTimeMode,
    timestamp?: string,
  ): Date | null {
    if (timeMode === MetricQueryTimeMode.SNAPSHOT) {
      return null;
    }

    if (timeMode === MetricQueryTimeMode.POINT_IN_TIME) {
      if (!timestamp) {
        throw new BadRequestException(
          'timestamp is required for point_in_time execution',
        );
      }

      const parsed = new Date(timestamp);

      if (Number.isNaN(parsed.getTime())) {
        throw new BadRequestException('timestamp must be a valid ISO date');
      }

      return parsed;
    }

    throw new BadRequestException(`Unsupported timeMode "${timeMode}"`);
  }

  private async resolveRuntimeConcept(
    input: {
      conceptId?: string;
      query?: string;
    },
    shipId: string,
  ): Promise<MetricConceptRuntimeNode> {
    const conceptId =
      input.conceptId ??
      (await this.resolveConceptIdFromQuery(input.query, shipId));

    if (!conceptId) {
      throw new BadRequestException('conceptId or query is required');
    }

    return this.loadConcept(conceptId, shipId);
  }

  private async resolveConceptIdFromQuery(
    query: string | undefined,
    shipId: string,
  ): Promise<string | undefined> {
    const normalizedQuery = query?.trim();

    if (!normalizedQuery) {
      return undefined;
    }

    const resolution = await this.metricsSemanticCatalogService.resolveConcept({
      query: normalizedQuery,
      shipId,
    });

    if (!resolution.resolvedConcept) {
      throw new NotFoundException('No metric concept matched the provided query');
    }

    return resolution.resolvedConcept.id;
  }

  private async loadConcept(
    conceptId: string,
    shipId: string,
  ): Promise<MetricConceptRuntimeNode> {
    const concept = await this.metricConceptRepository.findOne({
      where: {
        id: conceptId,
        isActive: true,
      },
      relations: {
        members: {
          metricCatalog: true,
        },
      },
    });

    if (!concept) {
      throw new NotFoundException('Metric concept not found');
    }

    const scopedMembers = [...(concept.members ?? [])]
      .filter((member) => member.metricCatalog.shipId === shipId)
      .sort(
        (left, right) =>
          left.sortOrder - right.sortOrder ||
          left.createdAt.getTime() - right.createdAt.getTime(),
      );

    return {
      concept: {
        ...concept,
        members: scopedMembers,
      },
      members: scopedMembers,
    };
  }

  private collectLeafMetrics(
    node: MetricConceptRuntimeNode,
    bucket: Map<string, ShipMetricCatalogEntity> = new Map(),
  ): ShipMetricCatalogEntity[] {
    for (const member of node.members) {
      bucket.set(member.metricCatalog.id, member.metricCatalog);
    }

    return [...bucket.values()];
  }

  private async fetchMetricSamples(
    organizationName: string,
    metrics: ShipMetricCatalogEntity[],
    timeMode: MetricQueryTimeMode,
    timestamp: Date | null,
  ): Promise<Map<string, InfluxMetricSample | null>> {
    const samples = await Promise.all(
      metrics.map(async (metric) => {
        const sample = await this.fetchSingleMetricSample(
          organizationName,
          metric,
          timeMode,
          timestamp,
        );

        return [metric.id, sample] as const;
      }),
    );

    return new Map(samples);
  }

  private async fetchSingleMetricSample(
    organizationName: string,
    metric: ShipMetricCatalogEntity,
    timeMode: MetricQueryTimeMode,
    timestamp: Date | null,
  ): Promise<InfluxMetricSample | null> {
    const selector = this.parseMetricSelector(metric);

    switch (timeMode) {
      case MetricQueryTimeMode.SNAPSHOT:
        return this.influxService.queryLatestMetric(organizationName, selector);
      case MetricQueryTimeMode.POINT_IN_TIME:
        if (!timestamp) {
          throw new BadRequestException(
            'timestamp is required for point_in_time execution',
          );
        }

        return this.influxService.queryMetricAtTime(
          organizationName,
          selector,
          timestamp,
        );
      default:
        throw new BadRequestException(`Unsupported timeMode "${timeMode}"`);
    }
  }

  private parseMetricSelector(
    metric: ShipMetricCatalogEntity,
  ): InfluxMetricSelector {
    const [bucket, measurement, field] = metric.key.split('::');

    if (!bucket || !measurement || !field) {
      throw new BadRequestException(
        `Metric catalog key "${metric.key}" cannot be parsed into bucket/measurement/field`,
      );
    }

    return {
      bucket: metric.bucket || bucket,
      measurement,
      field: metric.field || field,
    };
  }

  private buildExecutionResult(
    node: MetricConceptRuntimeNode,
    samples: Map<string, InfluxMetricSample | null>,
  ): MetricConceptExecutionResultDto {
    const members = node.members.map((member) =>
      this.buildExecutionMember(member, samples),
    );
    const aggregate = this.computeNodeAggregate(node, members);

    return {
      conceptId: node.concept.id,
      conceptSlug: node.concept.slug,
      conceptDisplayName: node.concept.displayName,
      type: node.concept.type,
      aggregationRule: node.concept.aggregationRule,
      value: aggregate.value,
      unit: aggregate.unit,
      timestamp: aggregate.timestamp,
      members,
      metadata: aggregate.metadata,
    };
  }

  private buildExecutionMember(
    member: MetricConceptMemberEntity,
    samples: Map<string, InfluxMetricSample | null>,
  ): MetricConceptExecutionMemberDto {
    const sample = samples.get(member.metricCatalog.id) ?? null;

    return {
      memberId: member.id,
      role: member.role,
      sourceType: 'metric',
      metricCatalogId: member.metricCatalog.id,
      label: this.buildMetricLabel(member.metricCatalog),
      key: member.metricCatalog.key,
      value: sample?.value ?? null,
      unit: null,
      timestamp: sample?.timestamp ?? null,
      description: member.metricCatalog.description,
      result: null,
    };
  }

  private computeNodeAggregate(
    node: MetricConceptRuntimeNode,
    members: MetricConceptExecutionMemberDto[],
  ): {
    value: unknown;
    unit: string | null;
    timestamp: string | null;
    metadata: Record<string, unknown> | null;
  } {
    const timestamp = this.selectRepresentativeTimestamp(members);

    switch (node.concept.type) {
      case MetricConceptType.SINGLE:
        return this.computeSingleAggregate(node, members, timestamp);
      case MetricConceptType.GROUP:
        return {
          value: members.map((member) => member.value),
          unit: node.concept.unit,
          timestamp,
          metadata: {
            memberCount: members.length,
          },
        };
      case MetricConceptType.PAIRED:
        return this.computePairedAggregate(node, members, timestamp);
      case MetricConceptType.COMPOSITE:
        return this.computeCompositeAggregate(node, members, timestamp);
      case MetricConceptType.COMPARISON:
      case MetricConceptType.TRAJECTORY:
      default:
        throw new BadRequestException(
          `Execution for concept type "${node.concept.type}" is not implemented yet`,
        );
    }
  }

  private computeSingleAggregate(
    node: MetricConceptRuntimeNode,
    members: MetricConceptExecutionMemberDto[],
    timestamp: string | null,
  ) {
    if (members.length !== 1) {
      throw new BadRequestException(
        `Single concept "${node.concept.slug}" must contain exactly one member`,
      );
    }

    const member = members[0];

    return {
      value: member.value,
      unit: node.concept.unit ?? member.unit,
      timestamp: member.timestamp ?? timestamp,
      metadata: null,
    };
  }

  private computePairedAggregate(
    node: MetricConceptRuntimeNode,
    members: MetricConceptExecutionMemberDto[],
    timestamp: string | null,
  ) {
    const latitudeMember =
      members.find((member) => this.normalizeRole(member.role) === 'latitude') ??
      members[0] ??
      null;
    const longitudeMember =
      members.find((member) => this.normalizeRole(member.role) === 'longitude') ??
      members[1] ??
      null;
    const latitude =
      latitudeMember && typeof latitudeMember.value === 'number'
        ? latitudeMember.value
        : null;
    const longitude =
      longitudeMember && typeof longitudeMember.value === 'number'
        ? longitudeMember.value
        : null;

    return {
      value:
        latitude !== null && longitude !== null
          ? {
              latitude,
              longitude,
            }
          : null,
      unit: node.concept.unit,
      timestamp,
      metadata: {
        latitudeMember: latitudeMember?.label ?? null,
        longitudeMember: longitudeMember?.label ?? null,
        complete: latitude !== null && longitude !== null,
      },
    };
  }

  private computeCompositeAggregate(
    node: MetricConceptRuntimeNode,
    members: MetricConceptExecutionMemberDto[],
    timestamp: string | null,
  ) {
    const numericValues = members.filter(
      (member): member is MetricConceptExecutionMemberDto & { value: number } =>
        typeof member.value === 'number',
    );
    const allNumeric = numericValues.length === members.length && members.length > 0;

    switch (node.concept.aggregationRule) {
      case MetricAggregationRule.SUM:
        return {
          value: allNumeric
            ? numericValues.reduce((total, member) => total + member.value, 0)
            : null,
          unit: node.concept.unit,
          timestamp,
          metadata: {
            complete: allNumeric,
            memberCount: members.length,
          },
        };
      case MetricAggregationRule.AVG:
        return {
          value: allNumeric
            ? numericValues.reduce((total, member) => total + member.value, 0) /
              members.length
            : null,
          unit: node.concept.unit,
          timestamp,
          metadata: {
            complete: allNumeric,
            memberCount: members.length,
          },
        };
      case MetricAggregationRule.MIN:
        return {
          value: allNumeric
            ? Math.min(...numericValues.map((member) => member.value))
            : null,
          unit: node.concept.unit,
          timestamp,
          metadata: {
            complete: allNumeric,
            memberCount: members.length,
          },
        };
      case MetricAggregationRule.MAX:
        return {
          value: allNumeric
            ? Math.max(...numericValues.map((member) => member.value))
            : null,
          unit: node.concept.unit,
          timestamp,
          metadata: {
            complete: allNumeric,
            memberCount: members.length,
          },
        };
      case MetricAggregationRule.LAST: {
        const candidate = [...members]
          .filter((member) => member.timestamp)
          .sort((left, right) =>
            (right.timestamp ?? '').localeCompare(left.timestamp ?? ''),
          )[0];

        return {
          value: candidate?.value ?? null,
          unit: node.concept.unit ?? candidate?.unit ?? null,
          timestamp: candidate?.timestamp ?? timestamp,
          metadata: {
            selectedMember: candidate?.label ?? null,
          },
        };
      }
      case MetricAggregationRule.COORDINATE_PAIR:
        return this.computePairedAggregate(node, members, timestamp);
      case MetricAggregationRule.NONE:
      default:
        return {
          value: null,
          unit: node.concept.unit,
          timestamp,
          metadata: {
            complete: false,
            reason: `Aggregation rule "${node.concept.aggregationRule}" is not executable for composite concepts`,
          },
        };
    }
  }

  private selectRepresentativeTimestamp(
    members: MetricConceptExecutionMemberDto[],
  ): string | null {
    const timestamps = members
      .map((member) => member.timestamp)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => right.localeCompare(left));

    return timestamps[0] ?? null;
  }

  private buildMetricLabel(metric: ShipMetricCatalogEntity): string {
    return buildMetricSemanticBlueprint(metric).displayName;
  }

  private normalizeRole(role: string | null): string {
    return role?.trim().toLowerCase() ?? '';
  }

  private serializeConceptSummary(concept: MetricConceptEntity) {
    return {
      id: concept.id,
      slug: concept.slug,
      displayName: concept.displayName,
      description: concept.description,
      category: concept.category,
      type: concept.type,
      aggregationRule: concept.aggregationRule,
      unit: concept.unit,
    };
  }
}
