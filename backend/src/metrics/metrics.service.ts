import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  InfluxMetric,
  InfluxMetricValue,
  InfluxHistoricalQueryRange,
  InfluxHistoricalSeriesOptions,
  InfluxdbService,
} from '../influxdb/influxdb.service';
import { PrismaService } from '../prisma/prisma.service';
import { TagLinksService } from '../tags/tag-links.service';
import { CreateMetricDefinitionDto } from './dto/create-metric-definition.dto';
import { MetricDescriptionService } from './metric-description.service';
import {
  TelemetryQuerySemanticNormalizerService,
  type TelemetrySemanticQuery,
} from './telemetry-query-semantic-normalizer.service';
import { UpdateMetricDefinitionDto } from './dto/update-metric-definition.dto';
import type { ChatNormalizedQuery } from '../chat/chat.types';

const TAG_SUMMARY_SELECT = {
  id: true,
  key: true,
  category: true,
  subcategory: true,
  item: true,
  description: true,
} as const;

const METRIC_SELECT = {
  key: true,
  label: true,
  description: true,
  unit: true,
  bucket: true,
  measurement: true,
  field: true,
  firstSeenAt: true,
  lastSeenAt: true,
  status: true,
  dataType: true,
  createdAt: true,
  tags: {
    take: 1,
    orderBy: {
      tag: { key: 'asc' },
    },
    select: {
      tag: {
        select: TAG_SUMMARY_SELECT,
      },
    },
  },
} as const;

interface SyncShipMetricsOptions {
  metrics?: InfluxMetric[];
  activeMetricKeys?: string[];
  scheduleDescriptions?: boolean;
  syncValues?: boolean;
}

interface DescriptionBackfillBatchResult {
  generated: number;
  cooldownMs: number;
}

interface ShipMetricsSyncJob {
  shipId: string;
  organizationName: string;
  activeMetricKeys?: string[];
}

interface ShipTelemetryEntry {
  key: string;
  label: string;
  description?: string | null;
  unit?: string | null;
  bucket?: string | null;
  measurement?: string | null;
  field?: string | null;
  dataType?: string | null;
  value: string | number | boolean | null;
  updatedAt?: Date | null;
}

interface ShipTelemetryContext {
  telemetry: Record<string, string | number | boolean | null>;
  totalActiveMetrics: number;
  matchedMetrics: number;
  prefiltered: boolean;
  matchMode: 'none' | 'sample' | 'exact' | 'direct' | 'related';
  clarification: {
    question: string;
    pendingQuery: string;
    actions: Array<{
      label: string;
      message: string;
      kind?: 'suggestion' | 'all';
    }>;
  } | null;
}

interface TelemetryListRequest {
  mode: 'sample' | 'full';
  limit?: number;
}

interface NavigationMotionTelemetryIntent {
  wantsLocation: boolean;
  wantsSpeed: boolean;
  wantsWind: boolean;
  preferredSpeedKind?: 'sog' | 'stw' | 'vmg';
}

interface TelemetryQueryComponent {
  raw: string;
  normalized: string;
  subjectPhrase: string;
  commonSubjectPhrase: string;
  entityPhrase: string;
  measurementPhrase: string;
  measurementAnchorPhrase: string;
  hasMeasurementPhrase: boolean;
  hasMeaningfulSubject: boolean;
  queryKinds: Set<string>;
  tokenCount: number;
}

interface StoredFluidSubject {
  fluid: 'fuel' | 'oil' | 'water' | 'coolant' | 'def';
  waterQualifiers?: Array<'fresh' | 'sea' | 'black' | 'grey' | 'bilge'>;
}

interface ShipHistoricalTelemetryResolution {
  kind: 'none' | 'clarification' | 'answer';
  content?: string;
  pendingQuery?: string;
  clarificationQuestion?: string;
  clarificationActions?: Array<{
    label: string;
    message: string;
    kind?: 'suggestion' | 'all';
  }>;
}

interface HistoricalPositiveTelemetryEvent {
  entry: ShipTelemetryEntry;
  time: Date;
  delta: number;
  fromValue: number;
  toValue: number;
}

interface HistoricalTrendDeltaEntry {
  entry: ShipTelemetryEntry;
  fromValue: number;
  toValue: number;
  delta: number;
}

interface HistoricalTrendSeriesPoint {
  time: Date;
  value: number;
}

interface HistoricalTrendJumpSummary {
  fromTime: Date;
  toTime: Date;
  fromValue: number;
  toValue: number;
  delta: number;
  standout: boolean;
}

interface HistoricalTrendSeriesSummary {
  sampledEvery: string;
  aggregateStart: number;
  aggregateEnd: number;
  aggregateDelta: number;
  deltas: HistoricalTrendDeltaEntry[];
  lowest: HistoricalTrendSeriesPoint | null;
  highest: HistoricalTrendSeriesPoint | null;
  largestJump: HistoricalTrendJumpSummary | null;
}

interface ParsedHistoricalTelemetryRequest {
  metricQuery: string;
  operation:
    | 'point'
    | 'average'
    | 'min'
    | 'max'
    | 'sum'
    | 'trend'
    | 'delta'
    | 'position'
    | 'event';
  range: InfluxHistoricalQueryRange;
  pointInTime?: Date;
  rangeLabel: string;
  clarificationQuestion?: string;
  eventType?: 'bunkering' | 'fuel_increase';
  trendFocus?: 'general' | 'abrupt_change';
}

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly logger = new Logger(MetricsService.name);
  private isDescriptionBackfillRunning = false;
  private shouldRerunDescriptionBackfill = false;
  private descriptionBackfillResumeTimer: ReturnType<typeof setTimeout> | null =
    null;
  private descriptionBackfillResumeAt = 0;
  private isShipSyncRunning = false;
  private readonly queuedShipSyncs = new Map<string, ShipMetricsSyncJob>();
  private readonly shipSyncOrder: string[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly influxdb: InfluxdbService,
    private readonly metricDescriptions: MetricDescriptionService,
    @Optional() private readonly tagLinks?: TagLinksService,
    @Optional()
    private readonly telemetrySemanticNormalizer?: TelemetryQuerySemanticNormalizerService,
  ) {}

  onModuleInit() {
    this.scheduleDescriptionBackfill('startup');
    void this.resumePendingShipSyncs().catch((error) => {
      this.logger.error(
        'Failed to resume pending ship metric syncs',
        error instanceof Error ? error.stack : String(error),
      );
    });
  }

  async listOrganizations(): Promise<string[]> {
    if (!this.influxdb.isConfigured()) {
      throw new ServiceUnavailableException(
        'InfluxDB is not configured. Set INFLUX_URL and INFLUX_TOKEN',
      );
    }

    return this.influxdb.listOrganizations();
  }

  async listOrganizationMetrics(
    organizationName: string,
  ): Promise<InfluxMetric[]> {
    const normalizedOrganizationName = organizationName.trim();
    if (!normalizedOrganizationName) {
      throw new BadRequestException('organizationName is required');
    }
    if (!this.influxdb.isConfigured()) {
      throw new ServiceUnavailableException(
        'InfluxDB is not configured. Set INFLUX_URL and INFLUX_TOKEN',
      );
    }

    return this.influxdb.listAllMetrics(normalizedOrganizationName);
  }

  async syncCatalogFromInflux() {
    if (!this.influxdb.isConfigured()) {
      throw new ServiceUnavailableException(
        'InfluxDB is not configured. Set INFLUX_URL and INFLUX_TOKEN',
      );
    }

    const ships = await this.prisma.ship.findMany({
      where: { organizationName: { not: null } },
      select: { id: true, organizationName: true },
    });

    const organizationMetrics = new Map<string, InfluxMetric[]>();
    const buckets = new Set<string>();
    let metricsSynced = 0;

    for (const ship of ships) {
      const organizationName = ship.organizationName?.trim();
      if (!organizationName) continue;

      let metrics = organizationMetrics.get(organizationName);
      if (!metrics) {
        metrics = await this.listOrganizationMetrics(organizationName);
        organizationMetrics.set(organizationName, metrics);
      }

      const result = await this.syncShipMetricCatalog(
        ship.id,
        organizationName,
        {
          metrics,
          scheduleDescriptions: false,
        },
      );

      metricsSynced += result.metricsSynced;
      result.buckets.forEach((bucket) => buckets.add(bucket));
    }

    const pendingDescriptions = await this.countPendingDescriptions();
    this.scheduleDescriptionBackfill('scheduled-sync');

    return {
      shipsSynced: ships.length,
      organizations: [...organizationMetrics.keys()],
      buckets: [...buckets],
      metricsSynced,
      pendingDescriptions,
    };
  }

  async syncValuesFromInflux() {
    if (!this.influxdb.isConfigured()) {
      throw new ServiceUnavailableException(
        'InfluxDB is not configured. Set INFLUX_URL and INFLUX_TOKEN',
      );
    }

    const ships = await this.prisma.ship.findMany({
      where: { organizationName: { not: null } },
      select: {
        id: true,
        organizationName: true,
        metricsConfig: {
          where: { isActive: true },
          select: { metricKey: true },
        },
      },
    });

    const organizations = new Set<string>();
    const buckets = new Set<string>();
    let valuesUpdated = 0;
    let metricsQueried = 0;

    const shipsByOrganization = new Map<
      string,
      { id: string; metricKeys: string[] }[]
    >();

    for (const ship of ships) {
      const organizationName = ship.organizationName?.trim();
      if (!organizationName) continue;

      organizations.add(organizationName);
      if (!shipsByOrganization.has(organizationName)) {
        shipsByOrganization.set(organizationName, []);
      }

      shipsByOrganization.get(organizationName)?.push({
        id: ship.id,
        metricKeys: ship.metricsConfig.map((config) => config.metricKey),
      });
    }

    for (const [organizationName, organizationShips] of shipsByOrganization) {
      const organizationMetricKeys = [
        ...new Set(
          organizationShips.flatMap((ship) => ship.metricKeys.filter(Boolean)),
        ),
      ];
      if (!organizationMetricKeys.length) continue;

      const values = await this.influxdb.queryLatestValues(
        organizationMetricKeys,
        organizationName,
      );
      const valueMap = new Map(values.map((value) => [value.key, value]));
      values.forEach((value) => buckets.add(value.bucket));
      metricsQueried += organizationMetricKeys.length;

      for (const ship of organizationShips) {
        valuesUpdated += await this.persistLatestValuesForShip(
          ship.id,
          ship.metricKeys,
          valueMap,
        );
      }
    }

    return {
      shipsSynced: ships.length,
      organizations: [...organizations],
      buckets: [...buckets],
      metricsQueried,
      valuesUpdated,
    };
  }

  async syncShipMetrics(
    shipId: string,
    organizationName: string,
    options: SyncShipMetricsOptions = {},
  ) {
    const normalizedOrganizationName = organizationName.trim();
    if (!normalizedOrganizationName) {
      throw new BadRequestException('organizationName is required');
    }

    const metrics =
      options.metrics ??
      (await this.listOrganizationMetrics(normalizedOrganizationName));
    const result = await this.syncShipMetricCatalog(
      shipId,
      normalizedOrganizationName,
      {
        ...options,
        metrics,
      },
    );

    let valuesUpdated = 0;
    if (options.syncValues !== false) {
      valuesUpdated = await this.syncLatestValuesForShip(
        shipId,
        normalizedOrganizationName,
      );
    }

    return {
      ...result,
      valuesUpdated,
    };
  }

  async enqueueShipMetricsSync(
    shipId: string,
    organizationName: string,
    options: Pick<SyncShipMetricsOptions, 'activeMetricKeys'> = {},
  ) {
    const normalizedOrganizationName = organizationName.trim();
    if (!normalizedOrganizationName) {
      throw new BadRequestException('organizationName is required');
    }

    if (!this.queuedShipSyncs.has(shipId)) {
      this.shipSyncOrder.push(shipId);
    }

    this.queuedShipSyncs.set(shipId, {
      shipId,
      organizationName: normalizedOrganizationName,
      activeMetricKeys: options.activeMetricKeys,
    });

    this.ensureShipSyncQueueRunning();
  }

  async setShipMetricActivity(
    shipId: string,
    activeMetricKeys: string[],
    allowedMetricKeys?: string[],
  ) {
    const normalizedActiveKeys = [...new Set(activeMetricKeys)];
    const currentConfigs = await this.prisma.shipMetricsConfig.findMany({
      where: { shipId },
      select: { metricKey: true },
    });

    const knownMetricKeys = new Set(
      allowedMetricKeys ?? currentConfigs.map((config) => config.metricKey),
    );
    const invalidMetricKeys = normalizedActiveKeys.filter(
      (metricKey) => !knownMetricKeys.has(metricKey),
    );
    if (invalidMetricKeys.length > 0) {
      throw new BadRequestException(
        `Unknown metric keys: ${invalidMetricKeys.join(', ')}`,
      );
    }

    const currentMetricKeys = new Set(
      currentConfigs.map((config) => config.metricKey),
    );
    const missingActiveKeys = normalizedActiveKeys.filter(
      (metricKey) => !currentMetricKeys.has(metricKey),
    );

    await this.prisma.$transaction(async (tx) => {
      if (missingActiveKeys.length > 0) {
        await tx.shipMetricsConfig.createMany({
          data: missingActiveKeys.map((metricKey) => ({
            shipId,
            metricKey,
            isActive: true,
          })),
        });
      }

      await tx.shipMetricsConfig.updateMany({
        where: { shipId },
        data: { isActive: false },
      });

      if (normalizedActiveKeys.length > 0) {
        await tx.shipMetricsConfig.updateMany({
          where: {
            shipId,
            metricKey: { in: normalizedActiveKeys },
          },
          data: { isActive: true },
        });
      }
    });
  }

  async findAll() {
    const metrics = await this.prisma.metricDefinition.findMany({
      orderBy: { key: 'asc' },
      select: METRIC_SELECT,
    });

    return metrics.map((metric) => this.serializeMetricDefinition(metric));
  }

  async getLatestValues(keys: string[]): Promise<InfluxMetricValue[]> {
    if (!this.influxdb.isConfigured() || !keys.length) return [];
    return this.influxdb.queryLatestValues(keys);
  }

  async getShipTelemetry(
    shipId: string,
  ): Promise<Record<string, string | number | boolean | null>> {
    const entries = await this.loadShipTelemetryEntries(shipId);
    return this.toTelemetryMap(entries);
  }

  async getShipTelemetryContextForQuery(
    shipId: string,
    query: string,
    resolvedSubjectQuery?: string,
  ): Promise<ShipTelemetryContext> {
    const entries = await this.loadShipTelemetryEntries(shipId);
    const telemetrySemanticResolvedSubjectQuery =
      await this.buildTelemetrySemanticResolvedSubjectQuery({
        userQuery: query,
        resolvedSubjectQuery,
      });
    const effectiveResolvedSubjectQuery =
      this.mergeTelemetryResolvedSubjectQueries(
        resolvedSubjectQuery,
        telemetrySemanticResolvedSubjectQuery,
      );
    const scopedEntries = await this.applyTagPrefilterToEntries(
      shipId,
      entries,
      query,
      effectiveResolvedSubjectQuery,
    );
    if (!scopedEntries.length) {
      return {
        telemetry: {},
        totalActiveMetrics: 0,
        matchedMetrics: 0,
        prefiltered: false,
        matchMode: 'none',
        clarification: null,
      };
    }

    const telemetryListRequest = this.parseTelemetryListRequest(
      query,
      effectiveResolvedSubjectQuery,
    );
    if (telemetryListRequest?.mode === 'sample') {
      const sampleSelection = this.pickTelemetrySampleEntries(
        scopedEntries,
        query,
        effectiveResolvedSubjectQuery,
        telemetryListRequest.limit ?? 10,
      );
      return {
        telemetry: this.toTelemetryMap(sampleSelection.entries),
        totalActiveMetrics: scopedEntries.length,
        matchedMetrics: sampleSelection.totalMatches,
        prefiltered: true,
        matchMode: 'sample',
        clarification: null,
      };
    }

    const broadTankClarificationEntries =
      this.findBroadTankClarificationEntries(
        scopedEntries,
        query,
        effectiveResolvedSubjectQuery,
      );
    if (broadTankClarificationEntries) {
      return {
        telemetry: this.toTelemetryMap(broadTankClarificationEntries),
        totalActiveMetrics: scopedEntries.length,
        matchedMetrics: broadTankClarificationEntries.length,
        prefiltered: true,
        matchMode: 'related',
        clarification: this.buildTelemetryClarification(
          'related',
          broadTankClarificationEntries,
          query,
          effectiveResolvedSubjectQuery,
          'ambiguous_tank_reading',
        ),
      };
    }

    const matchedEntries = this.findRelevantTelemetryEntries(
      scopedEntries,
      query,
      effectiveResolvedSubjectQuery,
      { limitResults: telemetryListRequest?.mode !== 'full' },
    );

    if (matchedEntries.length > 0) {
      const baseMatchMode = this.determineTelemetryMatchMode(
        matchedEntries,
        query,
        effectiveResolvedSubjectQuery,
      );
      const forcedClarificationReason =
        this.getTelemetryForcedClarificationReason(
          baseMatchMode,
          matchedEntries,
          query,
          effectiveResolvedSubjectQuery,
        );
      const matchMode = forcedClarificationReason ? 'related' : baseMatchMode;
      return {
        telemetry: this.toTelemetryMap(matchedEntries),
        totalActiveMetrics: scopedEntries.length,
        matchedMetrics: matchedEntries.length,
        prefiltered: true,
        matchMode,
        clarification: this.buildTelemetryClarification(
          matchMode,
          matchedEntries,
          query,
          effectiveResolvedSubjectQuery,
          forcedClarificationReason,
        ),
      };
    }

    const normalizedSearchSpace = this.normalizeTelemetryText(
      `${query}\n${effectiveResolvedSubjectQuery ?? ''}`,
    );
    if (this.hasStrictTelemetryContext(normalizedSearchSpace)) {
      const fallbackEntries = this.findTelemetryFallbackEntries(
        scopedEntries,
        query,
        effectiveResolvedSubjectQuery,
      );
      const fallbackMatchMode = fallbackEntries.length > 0 ? 'related' : 'none';

      return {
        telemetry: this.toTelemetryMap(fallbackEntries),
        totalActiveMetrics: scopedEntries.length,
        matchedMetrics: fallbackEntries.length,
        prefiltered: fallbackEntries.length > 0,
        matchMode: fallbackMatchMode,
        clarification:
          fallbackEntries.length > 0
            ? this.buildTelemetryClarification(
                fallbackMatchMode,
                fallbackEntries,
                query,
                effectiveResolvedSubjectQuery,
              )
            : null,
      };
    }

    // Preserve current behaviour for small ships while avoiding massive prompt
    // dumps when thousands of metrics are active.
    if (scopedEntries.length <= 25) {
      return {
        telemetry: this.toTelemetryMap(scopedEntries),
        totalActiveMetrics: scopedEntries.length,
        matchedMetrics: 0,
        prefiltered: false,
        matchMode: 'none',
        clarification: null,
      };
    }

    const fallbackEntries = this.findTelemetryFallbackEntries(
      scopedEntries,
      query,
      effectiveResolvedSubjectQuery,
    );

    const fallbackMatchMode = fallbackEntries.length > 0 ? 'related' : 'none';
    return {
      telemetry: this.toTelemetryMap(fallbackEntries),
      totalActiveMetrics: scopedEntries.length,
      matchedMetrics: fallbackEntries.length,
      prefiltered: fallbackEntries.length > 0,
      matchMode: fallbackMatchMode,
      clarification:
        fallbackEntries.length > 0
          ? this.buildTelemetryClarification(
              fallbackMatchMode,
              fallbackEntries,
              query,
              effectiveResolvedSubjectQuery,
            )
          : null,
    };
  }

  async resolveHistoricalTelemetryQuery(
    shipId: string,
    query: string,
    resolvedSubjectQuery?: string,
    normalizedQuery?: ChatNormalizedQuery,
  ): Promise<ShipHistoricalTelemetryResolution> {
    this.logger.debug(
      `Historical telemetry resolver input ship=${shipId} query="${this.truncateTelemetryLogValue(
        query,
      )}" resolvedSubjectQuery="${this.truncateTelemetryLogValue(
        resolvedSubjectQuery ?? '',
      )}"`,
    );
    const parsedRequest = this.parseHistoricalTelemetryRequest(
      query,
      resolvedSubjectQuery,
      normalizedQuery,
    );
    if (!parsedRequest) {
      this.logger.debug(
        `Historical telemetry parser returned none for ship=${shipId}`,
      );
      return { kind: 'none' };
    }

    this.logger.debug(
      `Historical telemetry parsed ship=${shipId} operation=${parsedRequest.operation} metricQuery="${this.truncateTelemetryLogValue(
        parsedRequest.metricQuery,
      )}" rangeLabel="${this.truncateTelemetryLogValue(
        parsedRequest.rangeLabel,
      )}" clarification="${this.truncateTelemetryLogValue(
        parsedRequest.clarificationQuestion ?? '',
      )}"`,
    );

    if (parsedRequest.clarificationQuestion) {
      return {
        kind: 'clarification',
        clarificationQuestion: parsedRequest.clarificationQuestion,
        pendingQuery: query.trim(),
      };
    }

    const ship = await this.prisma.ship.findUnique({
      where: { id: shipId },
      select: { organizationName: true },
    });
    const organizationName = ship?.organizationName?.trim() ?? '';
    if (!organizationName || !this.influxdb.isConfigured()) {
      this.logger.debug(
        `Historical telemetry resolver skipped ship=${shipId} organizationConfigured=${Boolean(
          organizationName,
        )} influxConfigured=${this.influxdb.isConfigured()}`,
      );
      return { kind: 'none' };
    }

    const entries = await this.loadShipTelemetryEntries(shipId);
    if (entries.length === 0) {
      return {
        kind: 'answer',
        content:
          'No active telemetry metrics are configured for historical lookup on this ship.',
      };
    }

    const telemetrySemanticResolvedSubjectQuery =
      await this.buildTelemetrySemanticResolvedSubjectQuery({
        userQuery: query,
        resolvedSubjectQuery:
          parsedRequest.metricQuery || resolvedSubjectQuery || undefined,
      });
    const effectiveResolvedSubjectQuery =
      this.mergeTelemetryResolvedSubjectQueries(
        resolvedSubjectQuery,
        parsedRequest.metricQuery,
        telemetrySemanticResolvedSubjectQuery,
      );
    const scopedEntries = await this.applyTagPrefilterToEntries(
      shipId,
      entries,
      query,
      effectiveResolvedSubjectQuery,
    );
    if (scopedEntries.length === 0) {
      return {
        kind: 'answer',
        content:
          'No active telemetry metrics matched the requested historical subject on this ship.',
      };
    }

    const broadTankClarificationEntries =
      this.findBroadTankClarificationEntries(
        scopedEntries,
        query,
        effectiveResolvedSubjectQuery,
      ) ??
      (scopedEntries.length < entries.length
        ? this.findBroadTankClarificationEntries(
            entries,
            query,
            effectiveResolvedSubjectQuery,
          )
        : null);
    if (broadTankClarificationEntries) {
      return {
        kind: 'clarification',
        clarificationQuestion:
          'I found multiple historical tank readings that could match this question. Which tank do you want to inspect?',
        pendingQuery: query.trim(),
        clarificationActions: this.buildHistoricalClarificationActions(
          broadTankClarificationEntries,
          parsedRequest,
        ),
      };
    }

    const matchedEntries = this.findHistoricalTelemetryEntries(
      scopedEntries,
      parsedRequest,
      effectiveResolvedSubjectQuery,
    );
    this.logger.debug(
      `Historical telemetry matching ship=${shipId} activeEntries=${scopedEntries.length} matchedEntries=${matchedEntries.length}`,
    );

    if (matchedEntries.length === 0) {
      return {
        kind: 'answer',
        content:
          'I could not find a matching telemetry metric for the requested historical lookup.',
      };
    }

    const matchMode =
      parsedRequest.operation === 'position'
        ? 'direct'
        : this.determineTelemetryMatchMode(
            matchedEntries,
            parsedRequest.metricQuery,
            effectiveResolvedSubjectQuery,
          );
    this.logger.debug(
      `Historical telemetry match mode ship=${shipId} mode=${matchMode} metricKeys=${matchedEntries
        .map((entry) => entry.key)
        .slice(0, 6)
        .join(', ')}`,
    );

    if (matchMode === 'related') {
      return {
        kind: 'clarification',
        clarificationQuestion:
          'I found related historical telemetry metrics for that period, but not one exact direct match. Which metric do you want to inspect?',
        pendingQuery: query.trim(),
        clarificationActions: this.buildHistoricalClarificationActions(
          matchedEntries,
          parsedRequest,
        ),
      };
    }

    const content = await this.buildHistoricalTelemetryAnswer({
      matchedEntries,
      organizationName,
      request: parsedRequest,
    });
    this.logger.debug(
      `Historical telemetry answer build ship=${shipId} hasContent=${Boolean(
        content,
      )}`,
    );

    if (!content) {
      return {
        kind: 'answer',
        content:
          'No historical telemetry values were found for the requested period.',
      };
    }

    return {
      kind: 'answer',
      content,
    };
  }

  async findOne(key: string) {
    const metric = await this.prisma.metricDefinition.findUnique({
      where: { key },
      select: METRIC_SELECT,
    });
    if (!metric) throw new NotFoundException('Metric definition not found');
    return this.serializeMetricDefinition(metric);
  }

  async listTags(key: string) {
    return this.tagLinks?.listMetricTags(key) ?? [];
  }

  async create(dto: CreateMetricDefinitionDto) {
    const key = String(dto.key).trim();
    const label = String(dto.label).trim();
    if (!key || key.length > 255) {
      throw new BadRequestException('key must be 1-255 characters');
    }
    if (!label || label.length > 100) {
      throw new BadRequestException('label must be 1-100 characters');
    }

    const existing = await this.prisma.metricDefinition.findUnique({
      where: { key },
    });
    if (existing) {
      throw new ConflictException(`Metric with key "${key}" already exists`);
    }
    const created = await this.prisma.metricDefinition.create({
      data: {
        key,
        label,
        description:
          dto.description != null
            ? String(dto.description).trim() || undefined
            : undefined,
        unit:
          dto.unit != null ? String(dto.unit).trim() || undefined : undefined,
        dataType: (dto.dataType ?? 'numeric').trim() || 'numeric',
        status: 'active',
      },
      select: METRIC_SELECT,
    });
    await this.tagLinks?.autoLinkMetrics([created.key]);
    return this.findOne(created.key);
  }

  async update(key: string, dto: UpdateMetricDefinitionDto) {
    const metric = await this.prisma.metricDefinition.findUnique({
      where: { key },
    });
    if (!metric) throw new NotFoundException('Metric definition not found');

    const data: Record<string, unknown> = {};
    if (dto.label !== undefined) {
      const label = String(dto.label).trim();
      if (!label || label.length > 100) {
        throw new BadRequestException('label must be 1-100 characters');
      }
      data.label = label;
    }
    if (dto.description !== undefined) {
      data.description = dto.description?.trim() || null;
    }
    if (dto.unit !== undefined) data.unit = dto.unit?.trim() || null;
    if (dto.dataType !== undefined) {
      data.dataType = (dto.dataType?.trim() || 'numeric').slice(0, 20);
    }

    if (Object.keys(data).length === 0) return this.findOne(key);

    const updated = await this.prisma.metricDefinition.update({
      where: { key },
      data,
      select: METRIC_SELECT,
    });
    await this.tagLinks?.autoLinkMetrics([updated.key]);
    return this.findOne(updated.key);
  }

  async replaceTags(key: string, tagIds: string[] | undefined) {
    return this.tagLinks?.replaceMetricTags(key, tagIds) ?? [];
  }

  async remove(key: string) {
    const metric = await this.prisma.metricDefinition.findUnique({
      where: { key },
      include: { configs: { take: 1 } },
    });
    if (!metric) throw new NotFoundException('Metric definition not found');
    if (metric.configs.length > 0) {
      throw new BadRequestException(
        'Cannot delete metric: it is used by one or more ships',
      );
    }
    await this.prisma.metricDefinition.delete({ where: { key } });
  }

  private serializeMetricDefinition(metric: {
    key: string;
    label: string;
    description: string | null;
    unit: string | null;
    bucket: string | null;
    measurement: string | null;
    field: string | null;
    firstSeenAt: Date | null;
    lastSeenAt: Date | null;
    status: string | null;
    dataType: string | null;
    createdAt: Date;
    tags: Array<{
      tag: {
        id: string;
        key: string;
        category: string;
        subcategory: string;
        item: string;
        description: string | null;
      };
    }>;
  }) {
    const { tags, ...rest } = metric;
    return {
      ...rest,
      tag: tags[0]?.tag ?? null,
    };
  }

  private async syncShipMetricCatalog(
    shipId: string,
    organizationName: string,
    options: SyncShipMetricsOptions = {},
  ) {
    const metrics =
      options.metrics ?? (await this.listOrganizationMetrics(organizationName));
    const shouldScheduleDescriptions = options.scheduleDescriptions !== false;
    const now = new Date();

    for (const metric of metrics) {
      await this.upsertSyncedMetric(metric, now);
    }

    const metricKeys = metrics.map((metric) => metric.key);
    await this.tagLinks?.autoLinkMetrics(metricKeys);
    await this.reconcileShipMetrics(shipId, metricKeys);

    if (options.activeMetricKeys !== undefined) {
      await this.setShipMetricActivity(
        shipId,
        options.activeMetricKeys,
        metricKeys,
      );
    }

    if (shouldScheduleDescriptions) {
      this.scheduleDescriptionBackfill(
        `ship-sync:${shipId}:${organizationName}`,
      );
    }

    return {
      organizationName,
      buckets: [...new Set(metrics.map((metric) => metric.bucket))],
      metricsSynced: metricKeys.length,
    };
  }

  private async loadShipTelemetryEntries(
    shipId: string,
  ): Promise<ShipTelemetryEntry[]> {
    const configs = await this.prisma.shipMetricsConfig.findMany({
      where: { shipId, isActive: true },
      select: {
        metricKey: true,
        latestValue: true,
        valueUpdatedAt: true,
        metric: {
          select: {
            label: true,
            description: true,
            unit: true,
            bucket: true,
            measurement: true,
            field: true,
            dataType: true,
          },
        },
      },
    });

    return configs.map((config) => ({
      key: config.metricKey,
      label: config.metric?.label ?? config.metricKey,
      description: config.metric?.description,
      unit: config.metric?.unit,
      bucket: config.metric?.bucket,
      measurement: config.metric?.measurement,
      field: config.metric?.field,
      dataType: config.metric?.dataType,
      value: (config.latestValue as string | number | boolean | null) ?? null,
      updatedAt: config.valueUpdatedAt,
    }));
  }

  private async buildTelemetrySemanticResolvedSubjectQuery(params: {
    userQuery: string;
    resolvedSubjectQuery?: string;
  }): Promise<string | undefined> {
    if (!this.telemetrySemanticNormalizer) {
      return undefined;
    }

    const semanticQuery = await this.telemetrySemanticNormalizer.normalize({
      userQuery: params.userQuery,
      resolvedSubjectQuery: params.resolvedSubjectQuery,
    });
    return this.buildTelemetrySemanticHintText(semanticQuery);
  }

  private buildTelemetrySemanticHintText(
    semanticQuery: TelemetrySemanticQuery,
  ): string | undefined {
    const hints = [
      ...semanticQuery.subjectTerms,
      ...semanticQuery.semanticPhrases,
      ...semanticQuery.measurementKinds.flatMap((kind) =>
        this.getTelemetrySemanticKindHintPhrases(
          kind,
          semanticQuery.preferredSpeedKind,
        ),
      ),
    ]
      .map((value) => value.trim())
      .filter(Boolean);
    if (hints.length === 0) {
      return undefined;
    }

    const uniqueHints: string[] = [];
    const seen = new Set<string>();
    for (const hint of hints) {
      const normalizedHint = this.normalizeTelemetryText(hint);
      if (!normalizedHint || seen.has(normalizedHint)) {
        continue;
      }
      seen.add(normalizedHint);
      uniqueHints.push(hint);
      if (uniqueHints.length >= 16) {
        break;
      }
    }

    return uniqueHints.length > 0 ? uniqueHints.join('\n') : undefined;
  }

  private getTelemetrySemanticKindHintPhrases(
    kind: string,
    preferredSpeedKind: TelemetrySemanticQuery['preferredSpeedKind'],
  ): string[] {
    switch (kind) {
      case 'location':
        return ['vessel location', 'vessel position', 'latitude', 'longitude'];
      case 'speed':
        return preferredSpeedKind === 'stw'
          ? ['vessel speed', 'speed through water']
          : preferredSpeedKind === 'vmg'
            ? ['vessel speed', 'velocity made good']
            : ['vessel speed', 'speed over ground'];
      case 'hours':
        return ['running hours', 'runtime', 'hour meter'];
      case 'status':
        return ['status', 'state', 'alarm'];
      case 'level':
        return ['level', 'quantity', 'remaining'];
      default:
        return [kind];
    }
  }

  private mergeTelemetryResolvedSubjectQueries(
    ...parts: Array<string | undefined>
  ): string | undefined {
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const part of parts) {
      const trimmed = part?.trim();
      if (!trimmed) {
        continue;
      }
      const normalized = this.normalizeTelemetryText(trimmed);
      if (!normalized || seen.has(normalized)) {
        continue;
      }
      seen.add(normalized);
      merged.push(trimmed);
    }
    return merged.length > 0 ? merged.join('\n') : undefined;
  }

  private async applyTagPrefilterToEntries(
    shipId: string,
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): Promise<ShipTelemetryEntry[]> {
    if (!this.tagLinks || entries.length <= 1) {
      return entries;
    }

    const intentQuery = [query, resolvedSubjectQuery]
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!intentQuery) {
      return entries;
    }

    const scopedMetricKeys =
      await this.tagLinks.findTaggedMetricKeysForShipQuery(shipId, intentQuery);
    if (
      scopedMetricKeys.length === 0 ||
      scopedMetricKeys.length >= entries.length
    ) {
      return entries;
    }

    const scopedMetricKeySet = new Set(scopedMetricKeys);
    const filtered = entries.filter((entry) =>
      scopedMetricKeySet.has(entry.key),
    );

    if (filtered.length > 0 && filtered.length < entries.length) {
      const rejectedScopeReason = this.getRejectedTagPrefilterReason(
        entries,
        filtered,
        query,
        resolvedSubjectQuery,
      );
      if (rejectedScopeReason) {
        this.logger.debug(
          `Telemetry tag prefilter bypassed ship=${shipId} query="${query.replace(/\s+/g, ' ').trim()}" reason=${rejectedScopeReason} scopedEntries=${filtered.length}/${entries.length}`,
        );
        return entries;
      }

      this.logger.debug(
        `Telemetry tag prefilter ship=${shipId} query="${query.replace(/\s+/g, ' ').trim()}" scopedEntries=${filtered.length}/${entries.length} sample=${filtered
          .map((entry) => entry.key)
          .slice(0, 5)
          .join(', ')}`,
      );
      return filtered;
    }

    return entries;
  }

  private getRejectedTagPrefilterReason(
    allEntries: ShipTelemetryEntry[],
    filteredEntries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): string | null {
    const allDirectMatches = this.findRelevantTelemetryEntries(
      allEntries,
      query,
      resolvedSubjectQuery,
      { limitResults: false },
    );
    const filteredDirectMatches = this.findRelevantTelemetryEntries(
      filteredEntries,
      query,
      resolvedSubjectQuery,
      { limitResults: false },
    );

    if (allDirectMatches.length > 0) {
      const fullMatchMode = this.determineTelemetryMatchMode(
        allDirectMatches,
        query,
        resolvedSubjectQuery,
      );
      const filteredMatchMode =
        filteredDirectMatches.length > 0
          ? this.determineTelemetryMatchMode(
              filteredDirectMatches,
              query,
              resolvedSubjectQuery,
            )
          : 'none';
      const fullHasDirectPath =
        fullMatchMode === 'exact' || fullMatchMode === 'direct';
      const filteredHasDirectPath =
        filteredMatchMode === 'exact' || filteredMatchMode === 'direct';

      if (fullHasDirectPath && !filteredHasDirectPath) {
        return 'suppressed_direct_match';
      }
    }

    const allBroadTankClarification = this.findBroadTankClarificationEntries(
      allEntries,
      query,
      resolvedSubjectQuery,
    );
    if (
      allBroadTankClarification &&
      !this.findBroadTankClarificationEntries(
        filteredEntries,
        query,
        resolvedSubjectQuery,
      )
    ) {
      return 'suppressed_tank_scope';
    }

    const normalizedSearchSpace = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    const fluid = this.detectStoredFluidSubject(normalizedSearchSpace);
    if (fluid) {
      const allAggregateEntries = this.findAggregateTankTelemetryEntries(
        allEntries,
        query,
        resolvedSubjectQuery,
        {
          strictDedicatedTankStorage: true,
        },
      );
      const filteredAggregateEntries = this.findAggregateTankTelemetryEntries(
        filteredEntries,
        query,
        resolvedSubjectQuery,
        {
          strictDedicatedTankStorage: true,
        },
      );

      if (
        allAggregateEntries.length > 0 &&
        filteredAggregateEntries.length < allAggregateEntries.length
      ) {
        return 'suppressed_inventory_aggregate';
      }
    }

    if (this.isTelemetryLocationQuery(normalizedSearchSpace)) {
      const allLocationEntries = this.findLocationTelemetryEntries(
        allEntries,
        query,
        resolvedSubjectQuery,
      );
      const filteredLocationEntries = this.findLocationTelemetryEntries(
        filteredEntries,
        query,
        resolvedSubjectQuery,
      );
      if (
        this.hasCoordinatePair(
          allLocationEntries,
          this.getExplicitTelemetryCoordinateKinds.bind(this),
        ) &&
        !this.hasCoordinatePair(
          filteredLocationEntries,
          this.getExplicitTelemetryCoordinateKinds.bind(this),
        )
      ) {
        return 'suppressed_location_pair';
      }
    }

    if (this.hasStrictTelemetryContext(normalizedSearchSpace)) {
      const allFallbackEntries = this.findTelemetryFallbackEntries(
        allEntries,
        query,
        resolvedSubjectQuery,
      );
      const filteredFallbackEntries = this.findTelemetryFallbackEntries(
        filteredEntries,
        query,
        resolvedSubjectQuery,
      );

      if (
        allFallbackEntries.length > 0 &&
        filteredFallbackEntries.length === 0
      ) {
        return 'suppressed_fallback_candidates';
      }
    }

    return null;
  }

  private findHistoricalTelemetryEntries(
    entries: ShipTelemetryEntry[],
    request: ParsedHistoricalTelemetryRequest,
    resolvedSubjectQuery?: string,
  ): ShipTelemetryEntry[] {
    if (request.operation === 'event') {
      const normalizedMetricQuery = this.normalizeTelemetryText(
        request.metricQuery,
      );
      const fuelTankEntries = entries
        .filter((entry) =>
          this.isHistoricalTankStorageEntry(entry, { fluid: 'fuel' }),
        )
        .sort((left, right) => {
          const tankRank =
            this.getTelemetryTankOrder(left) -
            this.getTelemetryTankOrder(right);
          return tankRank || left.key.localeCompare(right.key);
        });
      if (fuelTankEntries.length > 0) {
        return fuelTankEntries;
      }

      return this.findRelevantTelemetryEntries(
        entries,
        normalizedMetricQuery,
        resolvedSubjectQuery,
      );
    }

    if (request.operation === 'position') {
      return this.findLocationTelemetryEntries(
        entries,
        request.metricQuery,
        resolvedSubjectQuery,
      );
    }

    const searchSpace = this.normalizeTelemetryText(
      `${request.metricQuery}\n${resolvedSubjectQuery ?? ''}`,
    );
    const queryKinds = this.extractTelemetryQueryMeasurementKinds(searchSpace);
    const aggregateTankEntries =
      this.findHistoricalAggregateTankTelemetryEntries(
        entries,
        request,
        searchSpace,
      );
    if (aggregateTankEntries.length > 0) {
      return aggregateTankEntries;
    }

    if (request.operation === 'delta') {
      const counterMatches = entries.filter((entry) => {
        const haystack = this.buildTelemetryHaystack(entry);
        return (
          this.getHistoricalMetricSemanticKind(entry) === 'counter' &&
          this.matchesTelemetrySpecificContext(entry, searchSpace) &&
          (!/\bfuel\b/i.test(searchSpace) || /\bfuel\b/i.test(haystack))
        );
      });

      const directFuelUsageMatches = counterMatches.filter((entry) =>
        this.isHistoricalFuelUsageCounter(entry),
      );
      if (directFuelUsageMatches.length > 0) {
        return this.sortHistoricalTelemetryEntries(directFuelUsageMatches);
      }

      if (counterMatches.length > 0) {
        return this.sortHistoricalTelemetryEntries(counterMatches);
      }
    }

    if (queryKinds.has('load') && /\b(generator|genset)\b/i.test(searchSpace)) {
      const loadMatches = entries.filter((entry) => {
        const haystack = this.buildTelemetryHaystack(entry);
        return (
          this.matchesTelemetrySpecificContext(entry, searchSpace) &&
          this.matchesTelemetryKinds(entry, new Set(['load'])) &&
          /\b(generator|genset)\b/i.test(haystack)
        );
      });

      const preferredElectricalGensetLoadMatches = loadMatches.filter((entry) =>
        /\bsiemens genset\b/i.test(this.buildTelemetryHaystack(entry)),
      );
      if (preferredElectricalGensetLoadMatches.length > 0) {
        return this.sortHistoricalTelemetryEntries(
          preferredElectricalGensetLoadMatches,
        );
      }

      if (loadMatches.length > 0) {
        return this.sortHistoricalTelemetryEntries(loadMatches);
      }
    }

    return this.findRelevantTelemetryEntries(
      entries,
      request.metricQuery,
      resolvedSubjectQuery,
    );
  }

  private findHistoricalAggregateTankTelemetryEntries(
    entries: ShipTelemetryEntry[],
    request: ParsedHistoricalTelemetryRequest,
    normalizedQuery?: string,
  ): ShipTelemetryEntry[] {
    const searchSpace =
      normalizedQuery ?? this.normalizeTelemetryText(request.metricQuery);
    const subject = this.detectStoredFluidSubject(searchSpace);
    if (
      subject &&
      this.shouldUseHistoricalTankStorageAnalysis(request, searchSpace, subject)
    ) {
      return this.findHistoricalStoredFluidTankEntries(entries, subject);
    }

    const explicitAggregateEntries = this.findAggregateTankTelemetryEntries(
      entries,
      request.metricQuery,
      undefined,
      {
        strictDedicatedTankStorage: true,
      },
    );
    if (explicitAggregateEntries.length > 0) {
      return explicitAggregateEntries;
    }

    if (!this.isImplicitHistoricalFuelInventoryQuery(searchSpace)) {
      return [];
    }

    return this.findHistoricalStoredFluidTankEntries(entries, {
      fluid: 'fuel',
    });
  }

  private sortHistoricalTelemetryEntries(
    entries: ShipTelemetryEntry[],
  ): ShipTelemetryEntry[] {
    return [...entries].sort((left, right) => {
      const leftSide = this.getTelemetrySideRank(left);
      const rightSide = this.getTelemetrySideRank(right);
      return leftSide - rightSide || left.key.localeCompare(right.key);
    });
  }

  private getTelemetrySideRank(entry: ShipTelemetryEntry): number {
    const haystack = this.buildTelemetryHaystack(entry);
    if (/\b(port|ps)\b/i.test(haystack)) {
      return 1;
    }
    if (/\b(starboard|sb|stbd)\b/i.test(haystack)) {
      return 2;
    }
    return 3;
  }

  private async buildHistoricalTelemetryAnswer(params: {
    matchedEntries: ShipTelemetryEntry[];
    organizationName: string;
    request: ParsedHistoricalTelemetryRequest;
  }): Promise<string | null> {
    const { matchedEntries, organizationName, request } = params;
    const normalizedMetricQuery = this.normalizeTelemetryText(
      request.metricQuery,
    );
    const storedFluidSubject = this.detectStoredFluidSubject(
      normalizedMetricQuery,
    );
    const usesStoredFluidTankLevels =
      Boolean(storedFluidSubject) &&
      matchedEntries.every((entry) =>
        this.isHistoricalAggregateTankStorageEntry(
          entry,
          storedFluidSubject as StoredFluidSubject,
        ),
      );
    const effectiveOperation =
      request.operation === 'sum' &&
      matchedEntries.every(
        (entry) => this.getHistoricalMetricSemanticKind(entry) === 'counter',
      )
        ? 'delta'
        : request.operation === 'trend' &&
            usesStoredFluidTankLevels &&
            storedFluidSubject &&
            this.isHistoricalStoredFluidUsageQuery(
              normalizedMetricQuery,
              storedFluidSubject,
            )
          ? 'delta'
          : request.operation;

    if (effectiveOperation === 'position') {
      return this.buildHistoricalPositionAnswer(
        matchedEntries,
        organizationName,
        request,
      );
    }

    if (effectiveOperation === 'event') {
      return this.buildHistoricalEventAnswer(
        matchedEntries,
        organizationName,
        request,
      );
    }

    if (effectiveOperation === 'trend') {
      return this.buildHistoricalTrendAnswer(
        matchedEntries,
        organizationName,
        request,
      );
    }

    if (request.pointInTime && effectiveOperation !== 'point') {
      return this.buildHistoricalPointAggregateAnswer(
        matchedEntries,
        organizationName,
        request,
        effectiveOperation,
      );
    }

    if (effectiveOperation === 'point') {
      return this.buildHistoricalPointAnswer(
        matchedEntries,
        organizationName,
        request,
      );
    }

    if (effectiveOperation === 'delta') {
      return this.buildHistoricalDeltaAnswer(
        matchedEntries,
        organizationName,
        request,
      );
    }

    return this.buildHistoricalAggregateAnswer(
      matchedEntries,
      organizationName,
      request,
      effectiveOperation,
    );
  }

  private async buildHistoricalPointAnswer(
    matchedEntries: ShipTelemetryEntry[],
    organizationName: string,
    request: ParsedHistoricalTelemetryRequest,
  ): Promise<string | null> {
    const pointInTime = request.pointInTime;
    if (!pointInTime) {
      return null;
    }

    const rows = await this.influxdb.queryHistoricalNearestValues(
      matchedEntries.map((entry) => entry.key),
      pointInTime,
      organizationName,
    );
    const nearestRows = this.pickNearestHistoricalRows(rows, pointInTime);
    if (nearestRows.length === 0) {
      return null;
    }

    const rowsByKey = new Map(nearestRows.map((row) => [row.key, row]));
    const lines = matchedEntries
      .map((entry) => {
        const row = rowsByKey.get(entry.key);
        if (!row) return null;
        const formattedValue = this.formatHistoricalMetricValue(
          entry,
          row.value,
        );
        return `- ${this.buildTelemetrySuggestionLabel(entry)}: ${formattedValue}`;
      })
      .filter((line): line is string => Boolean(line));

    if (lines.length === 0) {
      return null;
    }

    if (lines.length === 1) {
      return `At ${request.rangeLabel}, ${lines[0].replace(/^- /, '')} [Telemetry History].`;
    }

    return [
      `At ${request.rangeLabel}, the matched historical telemetry readings were [Telemetry History]:`,
      '',
      ...lines,
    ].join('\n');
  }

  private async buildHistoricalPositionAnswer(
    matchedEntries: ShipTelemetryEntry[],
    organizationName: string,
    request: ParsedHistoricalTelemetryRequest,
  ): Promise<string | null> {
    const pointInTime = request.pointInTime;
    if (pointInTime) {
      const rows = await this.influxdb.queryHistoricalNearestValues(
        matchedEntries.map((entry) => entry.key),
        pointInTime,
        organizationName,
      );
      const nearestRows = this.pickNearestHistoricalRows(rows, pointInTime);
      const coordinatePair = this.extractHistoricalCoordinatePair(nearestRows);
      if (!coordinatePair) {
        return null;
      }

      return `At ${request.rangeLabel}, the vessel position was Latitude ${coordinatePair.latitude.toFixed(6)}, Longitude ${coordinatePair.longitude.toFixed(6)} [Telemetry History].`;
    }

    const boundary = await this.influxdb.queryHistoricalFirstLast(
      matchedEntries.map((entry) => entry.key),
      request.range,
      organizationName,
    );
    const firstPosition = this.extractHistoricalCoordinatePair(boundary.first);
    const lastPosition = this.extractHistoricalCoordinatePair(boundary.last);

    if (!firstPosition && !lastPosition) {
      return null;
    }

    if (firstPosition && lastPosition) {
      if (this.isSameCoordinateArea(firstPosition, lastPosition)) {
        return `For ${request.rangeLabel}, the vessel remained around Latitude ${firstPosition.latitude.toFixed(6)}, Longitude ${firstPosition.longitude.toFixed(6)} based on the first and last recorded positions in the requested period [Telemetry History].`;
      }

      return [
        `For ${request.rangeLabel}, the first recorded vessel position was Latitude ${firstPosition.latitude.toFixed(6)}, Longitude ${firstPosition.longitude.toFixed(6)} at ${this.formatHistoricalTimestamp(firstPosition.time)}, and the last recorded position was Latitude ${lastPosition.latitude.toFixed(6)}, Longitude ${lastPosition.longitude.toFixed(6)} at ${this.formatHistoricalTimestamp(lastPosition.time)} [Telemetry History].`,
        '',
        'Ask for a specific time if you need the exact position at one moment within that period.',
      ].join('\n');
    }

    const singlePosition = firstPosition ?? lastPosition;
    if (!singlePosition) {
      return null;
    }

    return `For ${request.rangeLabel}, the recorded vessel position was Latitude ${singlePosition.latitude.toFixed(6)}, Longitude ${singlePosition.longitude.toFixed(6)} at ${this.formatHistoricalTimestamp(singlePosition.time)} [Telemetry History].`;
  }

  private async buildHistoricalPointAggregateAnswer(
    matchedEntries: ShipTelemetryEntry[],
    organizationName: string,
    request: ParsedHistoricalTelemetryRequest,
    operation: 'average' | 'min' | 'max' | 'sum' | 'delta',
  ): Promise<string | null> {
    if (!request.pointInTime || operation === 'delta') {
      return null;
    }

    const rows = await this.influxdb.queryHistoricalNearestValues(
      matchedEntries.map((entry) => entry.key),
      request.pointInTime,
      organizationName,
    );
    const nearestRows = this.pickNearestHistoricalRows(
      rows,
      request.pointInTime,
    );
    if (nearestRows.length === 0) {
      return null;
    }

    const rowsByKey = new Map(nearestRows.map((row) => [row.key, row]));
    const values = matchedEntries
      .map((entry) => {
        const row = rowsByKey.get(entry.key);
        const numericValue = this.parseHistoricalNumericValue(row?.value);
        if (!row || numericValue == null) {
          return null;
        }

        return {
          entry,
          value: numericValue,
        };
      })
      .filter(
        (
          value,
        ): value is {
          entry: ShipTelemetryEntry;
          value: number;
        } => Boolean(value),
      );
    if (values.length === 0) {
      return null;
    }

    const unit = this.getConsistentHistoricalUnit(
      values.map((item) => item.entry),
    );
    const unitSuffix = unit ? ` ${unit}` : '';
    const labelMap: Record<'average' | 'min' | 'max' | 'sum', string> = {
      average: 'average',
      min: 'minimum',
      max: 'maximum',
      sum: 'total',
    };
    const overallValue =
      operation === 'min'
        ? Math.min(...values.map((item) => item.value))
        : operation === 'max'
          ? Math.max(...values.map((item) => item.value))
          : operation === 'sum'
            ? values.reduce((sum, item) => sum + item.value, 0)
            : values.reduce((sum, item) => sum + item.value, 0) / values.length;

    if (values.length === 1) {
      return `At ${request.rangeLabel}, the ${labelMap[operation]} ${this.buildTelemetrySuggestionLabel(values[0].entry)} was ${this.formatAggregateNumber(values[0].value)}${unitSuffix} [Telemetry History].`;
    }

    const lines = values.map(
      (item) =>
        `- ${this.buildTelemetrySuggestionLabel(item.entry)}: ${this.formatAggregateNumber(item.value)}${unitSuffix}`,
    );

    return [
      `At ${request.rangeLabel}, the ${labelMap[operation]} across the matched historical telemetry readings was ${this.formatAggregateNumber(overallValue)}${unitSuffix} [Telemetry History].`,
      '',
      ...lines,
    ].join('\n');
  }

  private async buildHistoricalEventAnswer(
    matchedEntries: ShipTelemetryEntry[],
    organizationName: string,
    request: ParsedHistoricalTelemetryRequest,
  ): Promise<string | null> {
    const seriesKeys = matchedEntries.map((entry) => entry.key);
    let positiveEvents: HistoricalPositiveTelemetryEvent[] = [];
    let selectedRange = request.range;
    let selectedSeriesOptions:
      | (InfluxHistoricalSeriesOptions & { windowMs: number })
      | undefined;
    let lastError: Error | null = null;

    for (const searchRange of this.getHistoricalEventSearchRanges(
      request.range,
    )) {
      try {
        const result = await this.queryHistoricalEventSeriesWithFallback(
          seriesKeys,
          searchRange,
          organizationName,
        );
        const candidateEvents = this.detectHistoricalPositiveEvents(
          matchedEntries,
          result.rows,
        );
        if (candidateEvents.length === 0) {
          continue;
        }

        positiveEvents = candidateEvents;
        selectedRange = searchRange;
        selectedSeriesOptions = result.selectedSeriesOptions;
        break;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (positiveEvents.length === 0 && lastError) {
      throw lastError;
    }

    if (positiveEvents.length === 0) {
      return null;
    }

    if (
      selectedSeriesOptions?.windowEvery &&
      selectedSeriesOptions.windowMs > 0
    ) {
      const refinementRange = this.buildHistoricalEventRefinementRange(
        selectedRange,
        positiveEvents[0].time,
        selectedSeriesOptions.windowMs,
      );
      if (refinementRange) {
        try {
          const refinedRows = await this.influxdb.queryHistoricalSeries(
            seriesKeys,
            refinementRange,
            organizationName,
          );
          const refinedPositiveEvents = this.detectHistoricalPositiveEvents(
            matchedEntries,
            refinedRows,
          );
          if (refinedPositiveEvents.length > 0) {
            positiveEvents = refinedPositiveEvents;
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'unknown error';
          this.logger.warn(
            `Historical event refinement failed; using coarse historical series. ${message}`,
          );
        }
      }
    }

    if (positiveEvents.length === 0) {
      return null;
    }

    const latestTimestamp = positiveEvents[0].time.getTime();
    const clusteredEvents = positiveEvents.filter(
      (event) => latestTimestamp - event.time.getTime() <= 30 * 60 * 1000,
    );
    const clusteredEntries = clusteredEvents.map((event) => event.entry);
    const unit = this.getConsistentHistoricalUnit(clusteredEntries);
    const unitSuffix = unit ? ` ${unit}` : '';
    const totalDelta = clusteredEvents.reduce(
      (sum, event) => sum + event.delta,
      0,
    );
    const lines = clusteredEvents
      .slice(0, 4)
      .map(
        (event) =>
          `- ${this.buildTelemetrySuggestionLabel(event.entry)}: ${this.formatAggregateNumber(event.fromValue)}${unitSuffix} -> ${this.formatAggregateNumber(event.toValue)}${unitSuffix} (${this.formatAggregateNumber(event.delta)}${unitSuffix})`,
      );
    const timestamp = this.formatHistoricalTimestamp(new Date(latestTimestamp));
    const eventLabel =
      request.eventType === 'bunkering'
        ? 'bunkering-like fuel increase'
        : 'fuel increase';

    if (clusteredEvents.length === 1) {
      const [event] = clusteredEvents;
      return `The latest historical ${eventLabel} was at ${timestamp}, when ${this.buildTelemetrySuggestionLabel(event.entry)} increased by ${this.formatAggregateNumber(event.delta)}${unitSuffix} [Telemetry History].`;
    }

    return [
      `The latest historical ${eventLabel} was at ${timestamp}, when the matched fuel readings increased by ${this.formatAggregateNumber(totalDelta)}${unitSuffix} [Telemetry History].`,
      '',
      ...lines,
    ].join('\n');
  }

  private detectHistoricalPositiveEvents(
    matchedEntries: ShipTelemetryEntry[],
    rows: InfluxMetricValue[],
  ): HistoricalPositiveTelemetryEvent[] {
    const rowsByKey = new Map<string, InfluxMetricValue[]>();
    for (const row of rows) {
      const existing = rowsByKey.get(row.key) ?? [];
      existing.push(row);
      rowsByKey.set(row.key, existing);
    }

    return matchedEntries
      .flatMap((entry) => {
        const series = [...(rowsByKey.get(entry.key) ?? [])].sort(
          (left, right) => Date.parse(left.time) - Date.parse(right.time),
        );
        const events: HistoricalPositiveTelemetryEvent[] = [];

        for (let index = 1; index < series.length; index += 1) {
          const previousValue = this.parseHistoricalNumericValue(
            series[index - 1]?.value,
          );
          const currentValue = this.parseHistoricalNumericValue(
            series[index]?.value,
          );
          if (previousValue == null || currentValue == null) {
            continue;
          }

          const delta = currentValue - previousValue;
          if (delta <= this.getHistoricalPositiveDeltaThreshold(entry)) {
            continue;
          }

          const eventTime = new Date(series[index].time);
          if (Number.isNaN(eventTime.getTime())) {
            continue;
          }

          events.push({
            entry,
            time: eventTime,
            delta,
            fromValue: previousValue,
            toValue: currentValue,
          });
        }

        return events;
      })
      .sort((left, right) => right.time.getTime() - left.time.getTime());
  }

  private getHistoricalEventSeriesOptions(
    range: InfluxHistoricalQueryRange,
  ): Array<InfluxHistoricalSeriesOptions & { windowMs: number }> {
    const durationMs = this.getHistoricalRangeDurationMs(range);
    if (durationMs == null || durationMs <= 2 * 24 * 60 * 60 * 1000) {
      return [];
    }

    if (durationMs > 120 * 24 * 60 * 60 * 1000) {
      return [
        { windowEvery: '1d', windowMs: 24 * 60 * 60 * 1000 },
        { windowEvery: '3d', windowMs: 3 * 24 * 60 * 60 * 1000 },
      ];
    }
    if (durationMs > 30 * 24 * 60 * 60 * 1000) {
      return [
        { windowEvery: '12h', windowMs: 12 * 60 * 60 * 1000 },
        { windowEvery: '1d', windowMs: 24 * 60 * 60 * 1000 },
      ];
    }
    if (durationMs > 7 * 24 * 60 * 60 * 1000) {
      return [
        { windowEvery: '12h', windowMs: 12 * 60 * 60 * 1000 },
        { windowEvery: '1d', windowMs: 24 * 60 * 60 * 1000 },
      ];
    }

    return [
      { windowEvery: '2h', windowMs: 2 * 60 * 60 * 1000 },
      { windowEvery: '6h', windowMs: 6 * 60 * 60 * 1000 },
    ];
  }

  private getHistoricalEventSearchRanges(
    range: InfluxHistoricalQueryRange,
  ): InfluxHistoricalQueryRange[] {
    const start = new Date(range.start);
    const stop = new Date(range.stop);
    if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) {
      return [range];
    }

    const durationMs = stop.getTime() - start.getTime();
    if (durationMs <= 0) {
      return [range];
    }

    const candidateWindowsMs: number[] = [];
    if (durationMs > 120 * 24 * 60 * 60 * 1000) {
      candidateWindowsMs.push(
        7 * 24 * 60 * 60 * 1000,
        14 * 24 * 60 * 60 * 1000,
        30 * 24 * 60 * 60 * 1000,
        90 * 24 * 60 * 60 * 1000,
      );
    } else if (durationMs > 30 * 24 * 60 * 60 * 1000) {
      candidateWindowsMs.push(
        7 * 24 * 60 * 60 * 1000,
        14 * 24 * 60 * 60 * 1000,
        30 * 24 * 60 * 60 * 1000,
      );
    } else if (durationMs > 14 * 24 * 60 * 60 * 1000) {
      candidateWindowsMs.push(
        7 * 24 * 60 * 60 * 1000,
        14 * 24 * 60 * 60 * 1000,
      );
    }

    const candidates = candidateWindowsMs
      .filter((windowMs) => durationMs > windowMs)
      .map((windowMs) => ({
        start: new Date(stop.getTime() - windowMs),
        stop,
      }));

    candidates.push({ start, stop });

    const deduped = new Map<string, InfluxHistoricalQueryRange>();
    for (const candidate of candidates) {
      const key = `${candidate.start.toISOString()}::${candidate.stop.toISOString()}`;
      if (!deduped.has(key)) {
        deduped.set(key, candidate);
      }
    }

    return [...deduped.values()];
  }

  private async queryHistoricalEventSeriesWithFallback(
    seriesKeys: string[],
    range: InfluxHistoricalQueryRange,
    organizationName: string,
  ): Promise<{
    rows: InfluxMetricValue[];
    selectedSeriesOptions?:
      | (InfluxHistoricalSeriesOptions & { windowMs: number })
      | undefined;
  }> {
    const coarseSeriesOptionCandidates =
      this.getHistoricalEventSeriesOptions(range);

    if (coarseSeriesOptionCandidates.length === 0) {
      return {
        rows: await this.influxdb.queryHistoricalSeries(
          seriesKeys,
          range,
          organizationName,
        ),
      };
    }

    let lastError: Error | null = null;
    for (const candidate of coarseSeriesOptionCandidates) {
      try {
        return {
          rows: await this.influxdb.queryHistoricalSeries(
            seriesKeys,
            range,
            organizationName,
            candidate,
          ),
          selectedSeriesOptions: candidate,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `Historical event series query failed for window=${candidate.windowEvery}. ${lastError.message}`,
        );
      }
    }

    if (lastError) {
      throw lastError;
    }

    return { rows: [] };
  }

  private getHistoricalRangeDurationMs(
    range: InfluxHistoricalQueryRange,
  ): number | null {
    const start = new Date(range.start);
    const stop = new Date(range.stop);
    if (Number.isNaN(start.getTime()) || Number.isNaN(stop.getTime())) {
      return null;
    }

    const durationMs = stop.getTime() - start.getTime();
    return durationMs > 0 ? durationMs : null;
  }

  private buildHistoricalEventRefinementRange(
    originalRange: InfluxHistoricalQueryRange,
    approximateEventTime: Date,
    windowMs: number,
  ): InfluxHistoricalQueryRange | null {
    const originalStart = new Date(originalRange.start);
    const originalStop = new Date(originalRange.stop);
    if (
      Number.isNaN(originalStart.getTime()) ||
      Number.isNaN(originalStop.getTime()) ||
      Number.isNaN(approximateEventTime.getTime())
    ) {
      return null;
    }

    const paddingMs = Math.max(windowMs * 2, 2 * 60 * 60 * 1000);
    const start = new Date(
      Math.max(
        originalStart.getTime(),
        approximateEventTime.getTime() - paddingMs,
      ),
    );
    const stop = new Date(
      Math.min(
        originalStop.getTime(),
        approximateEventTime.getTime() + paddingMs,
      ),
    );

    return stop.getTime() > start.getTime() ? { start, stop } : null;
  }

  private async buildHistoricalDeltaAnswer(
    matchedEntries: ShipTelemetryEntry[],
    organizationName: string,
    request: ParsedHistoricalTelemetryRequest,
  ): Promise<string | null> {
    const boundary = await this.influxdb.queryHistoricalFirstLast(
      matchedEntries.map((entry) => entry.key),
      request.range,
      organizationName,
    );
    const firstByKey = new Map(boundary.first.map((row) => [row.key, row]));
    const lastByKey = new Map(boundary.last.map((row) => [row.key, row]));

    const deltas = matchedEntries
      .map((entry) => {
        const first = this.parseHistoricalNumericValue(
          firstByKey.get(entry.key)?.value,
        );
        const last = this.parseHistoricalNumericValue(
          lastByKey.get(entry.key)?.value,
        );
        if (first == null || last == null) {
          return null;
        }

        return {
          entry,
          fromValue: first,
          toValue: last,
          delta: last - first,
        };
      })
      .filter(
        (
          value,
        ): value is {
          entry: ShipTelemetryEntry;
          fromValue: number;
          toValue: number;
          delta: number;
        } => Boolean(value),
      );

    if (deltas.length === 0) {
      return null;
    }

    const normalizedMetricQuery = this.normalizeTelemetryText(
      request.metricQuery,
    );
    const storedFluidSubject = this.detectStoredFluidSubject(
      normalizedMetricQuery,
    );
    if (
      storedFluidSubject &&
      deltas.every((item) =>
        this.isHistoricalAggregateTankStorageEntry(
          item.entry,
          storedFluidSubject,
        ),
      )
    ) {
      return this.buildHistoricalStoredFluidTankDeltaAnswer({
        deltas,
        request,
        subject: storedFluidSubject,
      });
    }

    const total = deltas.reduce((sum, item) => sum + item.delta, 0);
    const unit = this.getConsistentHistoricalUnit(
      deltas.map((item) => item.entry),
    );
    const unitSuffix = unit ? ` ${unit}` : '';
    const lines = deltas.map(
      (item) =>
        `- ${this.buildTelemetrySuggestionLabel(item.entry)}: ${this.formatAggregateNumber(item.delta)}${unitSuffix}`,
    );

    if (deltas.length === 1) {
      return `Based on historical telemetry from ${request.rangeLabel}, ${this.buildTelemetrySuggestionLabel(deltas[0].entry)} changed by ${this.formatAggregateNumber(deltas[0].delta)}${unitSuffix} [Telemetry History].`;
    }

    return [
      `Based on historical telemetry from ${request.rangeLabel}, the total across the matched metrics was ${this.formatAggregateNumber(total)}${unitSuffix} [Telemetry History].`,
      '',
      ...lines,
    ].join('\n');
  }

  private buildHistoricalStoredFluidTankDeltaAnswer(params: {
    deltas: Array<{
      entry: ShipTelemetryEntry;
      fromValue: number;
      toValue: number;
      delta: number;
    }>;
    request: ParsedHistoricalTelemetryRequest;
    subject: StoredFluidSubject;
  }): string {
    const { deltas, request, subject } = params;
    const totalStart = deltas.reduce((sum, item) => sum + item.fromValue, 0);
    const totalEnd = deltas.reduce((sum, item) => sum + item.toValue, 0);
    const netDelta = totalEnd - totalStart;
    const unit = this.getConsistentHistoricalUnit(
      deltas.map((item) => item.entry),
    );
    const unitSuffix = unit ? ` ${unit}` : '';
    const fluidLabel = this.describeStoredFluidSubject(subject);
    const lines = deltas.map(
      (item) =>
        `- ${this.buildTelemetrySuggestionLabel(item.entry)}: ${this.formatAggregateNumber(item.fromValue)}${unitSuffix} -> ${this.formatAggregateNumber(item.toValue)}${unitSuffix} (${this.formatSignedAggregateNumber(item.delta)}${unitSuffix})`,
    );
    const normalizedMetricQuery = this.normalizeTelemetryText(
      request.metricQuery,
    );
    const usageQuery = this.isHistoricalStoredFluidUsageQuery(
      normalizedMetricQuery,
      subject,
    );

    if (usageQuery) {
      if (netDelta < 0) {
        const usedAmount = Math.abs(netDelta);
        const durationMs = this.getHistoricalRangeDurationMs(request.range);
        const dailyAverage =
          durationMs != null && durationMs > 0
            ? usedAmount / (durationMs / (24 * 60 * 60 * 1000))
            : null;
        const output = [
          `Based on tank-level telemetry from ${request.rangeLabel}, total ${fluidLabel} across the matched tanks fell from ${this.formatAggregateNumber(totalStart)}${unitSuffix} to ${this.formatAggregateNumber(totalEnd)}${unitSuffix}, which implies ${this.formatAggregateNumber(usedAmount)}${unitSuffix} used over that period [Telemetry History].`,
        ];

        if (dailyAverage != null && Number.isFinite(dailyAverage)) {
          output.push(
            '',
            `Average daily ${fluidLabel} usage over that period was approximately ${this.formatAggregateNumber(dailyAverage)}${unitSuffix} per day.`,
          );
        }

        if (lines.length > 1) {
          output.push('', 'Net change by matched tank:', ...lines);
        }

        return output.join('\n');
      }

      const output = [
        `Based on tank-level telemetry from ${request.rangeLabel}, total ${fluidLabel} across the matched tanks moved from ${this.formatAggregateNumber(totalStart)}${unitSuffix} to ${this.formatAggregateNumber(totalEnd)}${unitSuffix} (${this.formatSignedAggregateNumber(netDelta)}${unitSuffix}) [Telemetry History].`,
        '',
        `A pure ${fluidLabel} usage figure cannot be inferred from net tank levels for that period because the onboard total did not decrease overall.`,
      ];

      if (lines.length > 1) {
        output.push('', 'Net change by matched tank:', ...lines);
      }

      return output.join('\n');
    }

    const output = [
      `Based on tank-level telemetry from ${request.rangeLabel}, total ${fluidLabel} across the matched tanks moved from ${this.formatAggregateNumber(totalStart)}${unitSuffix} to ${this.formatAggregateNumber(totalEnd)}${unitSuffix} (${this.formatSignedAggregateNumber(netDelta)}${unitSuffix}) [Telemetry History].`,
    ];

    if (lines.length > 1) {
      output.push('', 'Net change by matched tank:', ...lines);
    }

    return output.join('\n');
  }

  private async buildHistoricalTrendAnswer(
    matchedEntries: ShipTelemetryEntry[],
    organizationName: string,
    request: ParsedHistoricalTelemetryRequest,
  ): Promise<string | null> {
    let seriesSummary: HistoricalTrendSeriesSummary | null = null;
    let seriesError: Error | null = null;
    try {
      seriesSummary = await this.buildHistoricalTrendSeriesSummary(
        matchedEntries,
        organizationName,
        request,
      );
    } catch (error) {
      seriesError = error instanceof Error ? error : new Error(String(error));
      this.logger.warn(
        `Historical trend series fallback failed. ${seriesError.message}`,
      );
    }

    if (!seriesSummary) {
      if (seriesError) {
        if (this.isHistoricalQueryTimeout(seriesError)) {
          return [
            `I found matching historical telemetry metrics for ${request.rangeLabel}, but the sampled trend query timed out before a reliable series could be assembled.`,
            '',
            'Try a shorter period or narrow the request to fewer metrics if you need a more detailed trend breakdown.',
          ].join('\n');
        }

        throw seriesError;
      }

      return 'I found matching historical telemetry metrics for that period, but not enough sampled points to describe a trend over time.';
    }

    const unit = this.getConsistentHistoricalUnit(matchedEntries);
    const unitSuffix = unit ? ` ${unit}` : '';
    const aggregateLabel =
      matchedEntries.length === 1
        ? this.buildTelemetrySuggestionLabel(matchedEntries[0])
        : 'the total across the matched metrics';

    const output: string[] = [
      `Based on historical telemetry sampled every ${seriesSummary.sampledEvery} from ${request.rangeLabel}, ${aggregateLabel} ${this.describeHistoricalTrendMovement(
        seriesSummary.aggregateStart,
        seriesSummary.aggregateEnd,
        seriesSummary.aggregateDelta,
      )}${unitSuffix} [Telemetry History].`,
    ];

    if (seriesSummary.lowest && seriesSummary.highest) {
      const rangeDelta =
        seriesSummary.highest.value - seriesSummary.lowest.value;
      if (
        !this.isNegligibleHistoricalChange(
          rangeDelta,
          seriesSummary.lowest.value,
          seriesSummary.highest.value,
        )
      ) {
        output.push(
          '',
          `In the sampled trend (${seriesSummary.sampledEvery} resolution), the lowest observed ${matchedEntries.length === 1 ? 'value' : 'total'} was ${this.formatAggregateNumber(seriesSummary.lowest.value)}${unitSuffix} at ${this.formatHistoricalTimestamp(seriesSummary.lowest.time)}, and the highest was ${this.formatAggregateNumber(seriesSummary.highest.value)}${unitSuffix} at ${this.formatHistoricalTimestamp(seriesSummary.highest.time)}.`,
        );
      }
    }

    if (request.trendFocus === 'abrupt_change') {
      output.push(
        '',
        this.buildHistoricalTrendJumpNarrative(
          seriesSummary.largestJump,
          unitSuffix,
        ),
      );
    } else if (seriesSummary.largestJump?.standout) {
      output.push(
        '',
        `The sharpest sampled interval move was ${this.formatSignedAggregateNumber(
          seriesSummary.largestJump.delta,
        )}${unitSuffix} between ${this.formatHistoricalTimestamp(
          seriesSummary.largestJump.fromTime,
        )} and ${this.formatHistoricalTimestamp(
          seriesSummary.largestJump.toTime,
        )}.`,
      );
    }

    if (seriesSummary.deltas.length > 1) {
      const lines = seriesSummary.deltas.map(
        (item) =>
          `- ${this.buildTelemetrySuggestionLabel(item.entry)}: ${this.formatAggregateNumber(item.fromValue)}${unitSuffix} -> ${this.formatAggregateNumber(item.toValue)}${unitSuffix} (${this.formatSignedAggregateNumber(item.delta)}${unitSuffix})`,
      );
      output.push(
        '',
        seriesSummary.deltas.length === matchedEntries.length
          ? 'Net change by matched metric:'
          : 'Net change by matched metric (where sampled start and end values were available):',
        ...lines,
      );
    }

    return output.join('\n');
  }

  private async buildHistoricalTrendSeriesSummary(
    matchedEntries: ShipTelemetryEntry[],
    organizationName: string,
    request: ParsedHistoricalTelemetryRequest,
  ): Promise<HistoricalTrendSeriesSummary | null> {
    const { rows, selectedSeriesOptions } =
      await this.queryHistoricalTrendSeriesWithFallback(
        matchedEntries.map((entry) => entry.key),
        request.range,
        organizationName,
      );
    const deltas = this.buildHistoricalTrendSampledDeltas(rows, matchedEntries);
    const points = this.buildHistoricalTrendSeriesPoints(
      rows,
      matchedEntries.length,
    );
    if (
      points.length < 2 &&
      (matchedEntries.length > 1 || deltas.length === 0)
    ) {
      return null;
    }

    const aggregateStart =
      points.length >= 2
        ? points[0].value
        : deltas.length === 1
          ? deltas[0].fromValue
          : deltas.reduce((sum, item) => sum + item.fromValue, 0);
    const aggregateEnd =
      points.length >= 2
        ? points[points.length - 1].value
        : deltas.length === 1
          ? deltas[0].toValue
          : deltas.reduce((sum, item) => sum + item.toValue, 0);
    const lowest =
      points.length >= 2
        ? points.reduce((best, point) =>
            point.value < best.value ? point : best,
          )
        : null;
    const highest =
      points.length >= 2
        ? points.reduce((best, point) =>
            point.value > best.value ? point : best,
          )
        : null;

    return {
      sampledEvery: selectedSeriesOptions.windowEvery ?? 'sampled',
      aggregateStart,
      aggregateEnd,
      aggregateDelta: aggregateEnd - aggregateStart,
      deltas,
      lowest,
      highest,
      largestJump:
        points.length >= 2
          ? this.buildHistoricalTrendJumpSummary(points)
          : null,
    };
  }

  private getHistoricalTrendSeriesOptions(
    range: InfluxHistoricalQueryRange,
  ): Array<InfluxHistoricalSeriesOptions & { windowMs: number }> {
    const durationMs = this.getHistoricalRangeDurationMs(range);
    if (durationMs == null) {
      return [{ windowEvery: '2h', windowMs: 2 * 60 * 60 * 1000 }];
    }

    if (durationMs <= 12 * 60 * 60 * 1000) {
      return [
        { windowEvery: '15m', windowMs: 15 * 60 * 1000 },
        { windowEvery: '30m', windowMs: 30 * 60 * 1000 },
      ];
    }
    if (durationMs <= 2 * 24 * 60 * 60 * 1000) {
      return [
        { windowEvery: '1h', windowMs: 60 * 60 * 1000 },
        { windowEvery: '2h', windowMs: 2 * 60 * 60 * 1000 },
      ];
    }
    if (durationMs <= 7 * 24 * 60 * 60 * 1000) {
      return [
        { windowEvery: '2h', windowMs: 2 * 60 * 60 * 1000 },
        { windowEvery: '6h', windowMs: 6 * 60 * 60 * 1000 },
      ];
    }
    if (durationMs <= 30 * 24 * 60 * 60 * 1000) {
      return [
        { windowEvery: '12h', windowMs: 12 * 60 * 60 * 1000 },
        { windowEvery: '1d', windowMs: 24 * 60 * 60 * 1000 },
      ];
    }
    if (durationMs <= 120 * 24 * 60 * 60 * 1000) {
      return [
        { windowEvery: '1d', windowMs: 24 * 60 * 60 * 1000 },
        { windowEvery: '3d', windowMs: 3 * 24 * 60 * 60 * 1000 },
      ];
    }

    return [
      { windowEvery: '3d', windowMs: 3 * 24 * 60 * 60 * 1000 },
      { windowEvery: '7d', windowMs: 7 * 24 * 60 * 60 * 1000 },
    ];
  }

  private async queryHistoricalTrendSeriesWithFallback(
    seriesKeys: string[],
    range: InfluxHistoricalQueryRange,
    organizationName: string,
  ): Promise<{
    rows: InfluxMetricValue[];
    selectedSeriesOptions: InfluxHistoricalSeriesOptions & { windowMs: number };
  }> {
    const candidates = this.getHistoricalTrendSeriesOptions(range);
    let lastError: Error | null = null;

    for (const candidate of candidates) {
      try {
        return {
          rows: await this.influxdb.queryHistoricalSeries(
            seriesKeys,
            range,
            organizationName,
            candidate,
          ),
          selectedSeriesOptions: candidate,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          `Historical trend series query failed for window=${candidate.windowEvery}. ${lastError.message}`,
        );
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('No historical trend series options were available');
  }

  private buildHistoricalTrendSeriesPoints(
    rows: InfluxMetricValue[],
    matchedEntryCount: number,
  ): HistoricalTrendSeriesPoint[] {
    const grouped = new Map<
      string,
      HistoricalTrendSeriesPoint & { coverage: number }
    >();

    for (const row of rows) {
      const numericValue = this.parseHistoricalNumericValue(row.value);
      const pointTime = new Date(row.time);
      if (numericValue == null || Number.isNaN(pointTime.getTime())) {
        continue;
      }

      const key = pointTime.toISOString();
      const existing = grouped.get(key);
      if (existing) {
        existing.value += numericValue;
        existing.coverage += 1;
        continue;
      }

      grouped.set(key, {
        time: pointTime,
        value: numericValue,
        coverage: 1,
      });
    }

    let points = [...grouped.values()].filter(
      (point) => matchedEntryCount <= 1 || point.coverage >= matchedEntryCount,
    );
    if (points.length < 2 && matchedEntryCount > 1) {
      const partialCoverageThreshold = Math.max(
        2,
        Math.ceil(matchedEntryCount * 0.75),
      );
      points = [...grouped.values()].filter(
        (point) => point.coverage >= partialCoverageThreshold,
      );
    }

    return points
      .sort((left, right) => left.time.getTime() - right.time.getTime())
      .map((point) => ({
        time: point.time,
        value: point.value,
      }));
  }

  private buildHistoricalTrendSampledDeltas(
    rows: InfluxMetricValue[],
    matchedEntries: ShipTelemetryEntry[],
  ): HistoricalTrendDeltaEntry[] {
    const rowsByKey = new Map<
      string,
      Array<{
        time: Date;
        value: number;
      }>
    >();

    for (const row of rows) {
      const numericValue = this.parseHistoricalNumericValue(row.value);
      const pointTime = new Date(row.time);
      if (numericValue == null || Number.isNaN(pointTime.getTime())) {
        continue;
      }

      const existing = rowsByKey.get(row.key);
      if (existing) {
        existing.push({ time: pointTime, value: numericValue });
        continue;
      }

      rowsByKey.set(row.key, [{ time: pointTime, value: numericValue }]);
    }

    return matchedEntries
      .map((entry) => {
        const series = rowsByKey.get(entry.key);
        if (!series || series.length < 2) {
          return null;
        }

        series.sort(
          (left, right) => left.time.getTime() - right.time.getTime(),
        );
        const first = series[0];
        const last = series[series.length - 1];
        return {
          entry,
          fromValue: first.value,
          toValue: last.value,
          delta: last.value - first.value,
        };
      })
      .filter((value): value is HistoricalTrendDeltaEntry => Boolean(value));
  }

  private buildHistoricalTrendJumpSummary(
    points: HistoricalTrendSeriesPoint[],
  ): HistoricalTrendJumpSummary | null {
    if (points.length < 2) {
      return null;
    }

    const jumps = points
      .slice(1)
      .map((point, index) => ({
        fromTime: points[index].time,
        toTime: point.time,
        fromValue: points[index].value,
        toValue: point.value,
        delta: point.value - points[index].value,
      }))
      .filter((jump) => Number.isFinite(jump.delta));

    if (jumps.length === 0) {
      return null;
    }

    const largestJump = jumps.reduce((best, jump) =>
      Math.abs(jump.delta) > Math.abs(best.delta) ? jump : best,
    );
    const absoluteJumpSizes = jumps
      .map((jump) => Math.abs(jump.delta))
      .sort((left, right) => left - right);
    const medianJumpSize = this.getMedianValue(absoluteJumpSizes);
    const values = points.map((point) => point.value);
    const observedRange = Math.max(...values) - Math.min(...values);
    const standoutThreshold = Math.max(
      medianJumpSize * 3,
      observedRange * 0.35,
    );

    return {
      ...largestJump,
      standout:
        Math.abs(largestJump.delta) > 0 &&
        Math.abs(largestJump.delta) >= standoutThreshold,
    };
  }

  private buildHistoricalTrendJumpNarrative(
    jump: HistoricalTrendJumpSummary | null,
    unitSuffix: string,
  ): string {
    if (!jump) {
      return 'I did not have enough sampled historical points to identify interval-by-interval jumps in that period.';
    }

    if (jump.standout) {
      return `A standout sampled interval change was observed between ${this.formatHistoricalTimestamp(
        jump.fromTime,
      )} and ${this.formatHistoricalTimestamp(jump.toTime)}, when the sampled reading moved from ${this.formatAggregateNumber(
        jump.fromValue,
      )}${unitSuffix} to ${this.formatAggregateNumber(
        jump.toValue,
      )}${unitSuffix} (${this.formatSignedAggregateNumber(jump.delta)}${unitSuffix}) [Telemetry History].`;
    }

    return `I did not find a clear standout abrupt change in the sampled trend. The largest sampled interval move was ${this.formatSignedAggregateNumber(
      jump.delta,
    )}${unitSuffix} between ${this.formatHistoricalTimestamp(
      jump.fromTime,
    )} and ${this.formatHistoricalTimestamp(jump.toTime)} [Telemetry History].`;
  }

  private describeHistoricalTrendMovement(
    fromValue: number,
    toValue: number,
    delta: number,
  ): string {
    if (this.isNegligibleHistoricalChange(delta, fromValue, toValue)) {
      return `remained broadly flat, moving from ${this.formatAggregateNumber(
        fromValue,
      )} to ${this.formatAggregateNumber(toValue)} (${this.formatSignedAggregateNumber(
        delta,
      )})`;
    }

    return `${delta >= 0 ? 'increased' : 'decreased'} from ${this.formatAggregateNumber(
      fromValue,
    )} to ${this.formatAggregateNumber(toValue)} (${this.formatSignedAggregateNumber(
      delta,
    )})`;
  }

  private async buildHistoricalAggregateAnswer(
    matchedEntries: ShipTelemetryEntry[],
    organizationName: string,
    request: ParsedHistoricalTelemetryRequest,
    operation: 'average' | 'min' | 'max' | 'sum',
  ): Promise<string | null> {
    const aggregateMap: Record<
      'average' | 'min' | 'max' | 'sum',
      'mean' | 'min' | 'max' | 'sum'
    > = {
      average: 'mean',
      min: 'min',
      max: 'max',
      sum: 'sum',
    };

    const rows = await this.influxdb.queryHistoricalAggregate(
      matchedEntries.map((entry) => entry.key),
      request.range,
      aggregateMap[operation],
      organizationName,
    );
    if (rows.length === 0) {
      return null;
    }

    const rowsByKey = new Map(rows.map((row) => [row.key, row]));
    const values = matchedEntries
      .map((entry) => {
        const row = rowsByKey.get(entry.key);
        const numericValue = this.parseHistoricalNumericValue(row?.value);
        if (!row || numericValue == null) {
          return null;
        }

        return {
          entry,
          value: numericValue,
        };
      })
      .filter(
        (
          value,
        ): value is {
          entry: ShipTelemetryEntry;
          value: number;
        } => Boolean(value),
      );

    if (values.length === 0) {
      return null;
    }

    const unit = this.getConsistentHistoricalUnit(
      values.map((item) => item.entry),
    );
    const unitSuffix = unit ? ` ${unit}` : '';
    const labelMap: Record<'average' | 'min' | 'max' | 'sum', string> = {
      average: 'average',
      min: 'minimum',
      max: 'maximum',
      sum: 'sum',
    };
    const lines = values.map(
      (item) =>
        `- ${this.buildTelemetrySuggestionLabel(item.entry)}: ${this.formatAggregateNumber(item.value)}${unitSuffix}`,
    );

    if (values.length === 1) {
      return `Based on historical telemetry from ${request.rangeLabel}, the ${labelMap[operation]} ${this.buildTelemetrySuggestionLabel(values[0].entry)} was ${this.formatAggregateNumber(values[0].value)}${unitSuffix} [Telemetry History].`;
    }

    const overallValue =
      operation === 'min'
        ? Math.min(...values.map((item) => item.value))
        : operation === 'max'
          ? Math.max(...values.map((item) => item.value))
          : values.reduce((sum, item) => sum + item.value, 0) /
            (operation === 'sum' ? 1 : values.length);
    const overallText =
      operation === 'sum'
        ? values.reduce((sum, item) => sum + item.value, 0)
        : overallValue;

    return [
      `Based on historical telemetry from ${request.rangeLabel}, the ${labelMap[operation]} across the matched metrics was ${this.formatAggregateNumber(overallText)}${unitSuffix} [Telemetry History].`,
      '',
      ...lines,
    ].join('\n');
  }

  private buildHistoricalClarificationActions(
    entries: ShipTelemetryEntry[],
    request: ParsedHistoricalTelemetryRequest,
  ): Array<{ label: string; message: string; kind?: 'suggestion' | 'all' }> {
    const selected: Array<{
      label: string;
      message: string;
      kind?: 'suggestion' | 'all';
    }> = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      const label = this.buildTelemetrySuggestionLabel(entry);
      const normalizedLabel = this.normalizeTelemetryText(label);
      if (!label || seen.has(normalizedLabel)) {
        continue;
      }

      seen.add(normalizedLabel);
      selected.push({
        label,
        message:
          request.operation === 'point' || request.operation === 'position'
            ? `What was ${label} at ${request.rangeLabel}?`
            : `What was ${label} during ${request.rangeLabel}?`,
        kind: 'suggestion',
      });

      if (selected.length >= 4) {
        break;
      }
    }

    return selected;
  }

  private parseHistoricalTelemetryRequest(
    query: string,
    resolvedSubjectQuery?: string,
    normalizedQuery?: ChatNormalizedQuery,
  ): ParsedHistoricalTelemetryRequest | null {
    const searchSpace = `${query}\n${resolvedSubjectQuery ?? ''}`;
    const normalized = this.normalizeTelemetryText(searchSpace);
    const positionQuery = this.isTelemetryLocationQuery(normalized);
    const operation = this.detectHistoricalOperation(
      searchSpace,
      positionQuery,
      normalizedQuery,
    );
    const trendFocus =
      operation === 'trend'
        ? this.detectHistoricalTrendFocus(searchSpace)
        : undefined;
    const missingYearFragment = this.findHistoricalDateWithoutYear(searchSpace);
    if (missingYearFragment) {
      return {
        metricQuery: this.sanitizeHistoricalMetricQuery(query),
        operation,
        range: { start: new Date(), stop: new Date() },
        rangeLabel: '',
        clarificationQuestion: `Which year do you mean for ${missingYearFragment}?`,
        ...(trendFocus ? { trendFocus } : {}),
      };
    }

    const relativeRange = this.parseRelativeHistoricalRange(searchSpace);
    const explicitDate = this.parseExplicitHistoricalDate(searchSpace);
    const explicitTime = this.parseHistoricalTimeOfDay(searchSpace);
    const relativePointInTime = this.parseRelativeHistoricalPoint(
      searchSpace,
      normalizedQuery,
    );
    const implicitRange = this.buildImplicitHistoricalRange(
      searchSpace,
      operation,
    );
    const metricQuery = this.sanitizeHistoricalMetricQuery(
      normalizedQuery?.subject?.trim()
        ? normalizedQuery.subject
        : resolvedSubjectQuery?.trim()
          ? resolvedSubjectQuery
          : query,
    );

    if (operation === 'event') {
      const range = this.buildDefaultHistoricalEventRange();
      return {
        metricQuery: metricQuery || 'fuel tank',
        operation,
        range,
        rangeLabel: this.formatHistoricalRange(range),
        eventType:
          normalizedQuery?.timeIntent.eventType ??
          (/\b(bunkering|refill)\b/i.test(searchSpace)
            ? 'bunkering'
            : 'fuel_increase'),
        ...(trendFocus ? { trendFocus } : {}),
      };
    }

    if (
      !relativeRange &&
      !explicitDate &&
      !relativePointInTime &&
      !implicitRange
    ) {
      return null;
    }

    if (
      relativeRange &&
      !explicitDate &&
      !explicitTime &&
      this.isForecastPlanningHistoryQuery(searchSpace)
    ) {
      return null;
    }

    if (operation === 'point' || operation === 'position') {
      if (relativePointInTime) {
        return {
          metricQuery,
          operation,
          range: {
            start: relativePointInTime,
            stop: relativePointInTime,
          },
          pointInTime: relativePointInTime,
          rangeLabel: this.formatHistoricalTimestamp(relativePointInTime),
          ...(trendFocus ? { trendFocus } : {}),
        };
      }

      if (!explicitTime) {
        if (operation === 'position') {
          const singleDayRange = explicitDate
            ? this.buildFullDayHistoricalRange(explicitDate)
            : this.isSingleUtcDayRange(relativeRange)
              ? relativeRange
              : null;

          if (singleDayRange) {
            return {
              metricQuery,
              operation,
              range: singleDayRange,
              rangeLabel: this.formatHistoricalDayOrRange(singleDayRange),
            };
          }
        }

        return {
          metricQuery,
          operation,
          range: { start: new Date(), stop: new Date() },
          rangeLabel: '',
          clarificationQuestion:
            operation === 'position'
              ? 'Please specify the exact time, or ask for a single day, for this historical position lookup.'
              : 'Please specify the exact time for this historical telemetry lookup.',
          ...(trendFocus ? { trendFocus } : {}),
        };
      }

      const baseDate = explicitDate
        ? explicitDate
        : relativeRange
          ? new Date(relativeRange.start)
          : null;
      if (!baseDate) {
        return null;
      }

      const pointInTime = new Date(
        Date.UTC(
          baseDate.getUTCFullYear(),
          baseDate.getUTCMonth(),
          baseDate.getUTCDate(),
          explicitTime.hours,
          explicitTime.minutes,
          0,
          0,
        ),
      );

      return {
        metricQuery,
        operation,
        range: {
          start: pointInTime,
          stop: pointInTime,
        },
        pointInTime,
        rangeLabel: this.formatHistoricalTimestamp(pointInTime),
        ...(trendFocus ? { trendFocus } : {}),
      };
    }

    if (relativePointInTime) {
      return {
        metricQuery,
        operation,
        range: {
          start: relativePointInTime,
          stop: relativePointInTime,
        },
        pointInTime: relativePointInTime,
        rangeLabel: this.formatHistoricalTimestamp(relativePointInTime),
        ...(trendFocus ? { trendFocus } : {}),
      };
    }

    const range =
      relativeRange ??
      implicitRange ??
      this.buildFullDayHistoricalRange(explicitDate!);
    return {
      metricQuery,
      operation,
      range,
      rangeLabel:
        implicitRange && !relativeRange && !explicitDate
          ? 'the last 24 hours'
          : this.formatHistoricalRange(range),
      ...(trendFocus ? { trendFocus } : {}),
    };
  }

  private isForecastPlanningHistoryQuery(query: string): boolean {
    const normalized = this.normalizeTelemetryText(query);
    return (
      /\b(forecast|budget|need|order)\b/i.test(normalized) &&
      /\b(next|coming|upcoming)\s+(month|week)\b/i.test(normalized)
    );
  }

  private detectHistoricalOperation(
    query: string,
    positionQuery: boolean,
    normalizedQuery?: ChatNormalizedQuery,
  ):
    | 'point'
    | 'average'
    | 'min'
    | 'max'
    | 'sum'
    | 'trend'
    | 'delta'
    | 'position'
    | 'event' {
    if (positionQuery) {
      return 'position';
    }

    if (normalizedQuery?.operation === 'event') {
      return 'event';
    }

    if (normalizedQuery?.operation === 'trend') {
      return 'trend';
    }

    const normalized = this.normalizeTelemetryText(query);
    if (
      /\b(last\s+bunkering|last\s+increase|fuel\s+last\s+increase|most\s+recent\s+refill|latest\s+refill)\b/i.test(
        normalized,
      )
    ) {
      return 'event';
    }
    if (/\b(average|avg|mean)\b/i.test(normalized)) {
      return 'average';
    }
    if (/\b(min|minimum|lowest|smallest|least)\b/i.test(normalized)) {
      return 'min';
    }
    if (/\b(max|maximum|highest|peak|largest|greatest)\b/i.test(normalized)) {
      return 'max';
    }
    if (this.isHistoricalTrendQuery(normalized)) {
      return 'trend';
    }
    if (
      /\b(used|usage|consumed|consumption|difference|delta|increase|decrease)\b/i.test(
        normalized,
      )
    ) {
      return 'delta';
    }
    if (/\b(total|sum|overall|combined)\b/i.test(normalized)) {
      return 'sum';
    }

    return 'point';
  }

  private isHistoricalTrendQuery(normalizedQuery: string): boolean {
    return (
      /\b(trend|trending|evolution|evolve|evolving|rise|rising|fall|falling|spike|spikes|jump|jumps|abrupt|abnormal|sudden|difference|different|diff|movement|moving)\b/i.test(
        normalizedQuery,
      ) ||
      (/\b(change|changed|changes|changing|difference|different|diff|movement|moving)\b/i.test(
        normalizedQuery,
      ) &&
        /\b(last|past|previous|over the last|history|historical)\b/i.test(
          normalizedQuery,
        ))
    );
  }

  private detectHistoricalTrendFocus(
    query: string,
  ): 'general' | 'abrupt_change' {
    const normalized = this.normalizeTelemetryText(query);
    if (
      /\b(spike|spikes|jump|jumps)\b/i.test(normalized) ||
      (/\b(sharp|abrupt|abnormal|sudden)\b/i.test(normalized) &&
        /\b(change|changes|movement|rise|drop|jump|spike)\b/i.test(normalized))
    ) {
      return 'abrupt_change';
    }

    return 'general';
  }

  private buildImplicitHistoricalRange(
    query: string,
    operation: ParsedHistoricalTelemetryRequest['operation'],
  ): InfluxHistoricalQueryRange | null {
    const normalized = this.normalizeTelemetryText(query);
    if (
      (operation !== 'delta' && operation !== 'trend') ||
      !this.isImplicitDailyStoredFluidUsageQuery(normalized)
    ) {
      return null;
    }

    const stop = new Date();
    const start = new Date(stop.getTime() - 24 * 60 * 60 * 1000);
    return { start, stop };
  }

  private parseRelativeHistoricalRange(
    query: string,
  ): InfluxHistoricalQueryRange | null {
    const now = new Date();
    const normalized = this.normalizeTelemetryText(query);
    const lastMatch = normalized.match(
      /\b(?:last|past|previous|over the last)\s+(\d+)\s+(hour|hours|day|days|week|weeks|month|months)\b/i,
    );
    if (lastMatch) {
      const amount = Number.parseInt(lastMatch[1], 10);
      const unit = lastMatch[2].toLowerCase();
      const start = new Date(now);
      if (unit.startsWith('hour'))
        start.setUTCHours(start.getUTCHours() - amount);
      if (unit.startsWith('day')) start.setUTCDate(start.getUTCDate() - amount);
      if (unit.startsWith('week'))
        start.setUTCDate(start.getUTCDate() - amount * 7);
      if (unit.startsWith('month'))
        start.setUTCMonth(start.getUTCMonth() - amount);
      return { start, stop: now };
    }

    const agoMatch = normalized.match(
      /\b(\d+)\s+(hour|hours|day|days|week|weeks|month|months)\s+ago\b/i,
    );
    if (agoMatch) {
      const amount = Number.parseInt(agoMatch[1], 10);
      const unit = agoMatch[2].toLowerCase();
      const pointInTime = new Date(now);
      if (unit.startsWith('hour'))
        pointInTime.setUTCHours(pointInTime.getUTCHours() - amount);
      if (unit.startsWith('day'))
        pointInTime.setUTCDate(pointInTime.getUTCDate() - amount);
      if (unit.startsWith('week'))
        pointInTime.setUTCDate(pointInTime.getUTCDate() - amount * 7);
      if (unit.startsWith('month'))
        pointInTime.setUTCMonth(pointInTime.getUTCMonth() - amount);
      return {
        start: this.startOfUtcDay(pointInTime),
        stop: this.endOfUtcDay(pointInTime),
      };
    }

    if (/\byesterday\b/i.test(normalized)) {
      const start = this.startOfUtcDay(
        new Date(now.getTime() - 24 * 60 * 60 * 1000),
      );
      const stop = this.endOfUtcDay(start);
      return { start, stop };
    }

    if (/\btoday\b/i.test(normalized)) {
      return { start: this.startOfUtcDay(now), stop: now };
    }

    if (/\bthis week\b/i.test(normalized)) {
      return { start: this.startOfUtcWeek(now), stop: now };
    }

    if (/\blast week\b/i.test(normalized)) {
      const endOfLastWeek = new Date(this.startOfUtcWeek(now).getTime() - 1);
      return {
        start: this.startOfUtcWeek(endOfLastWeek),
        stop: this.endOfUtcDay(endOfLastWeek),
      };
    }

    if (/\bthis month\b/i.test(normalized)) {
      return { start: this.startOfUtcMonth(now), stop: now };
    }

    if (/\blast month\b/i.test(normalized)) {
      const previousMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
      );
      return {
        start: this.startOfUtcMonth(previousMonth),
        stop: this.endOfUtcMonth(previousMonth),
      };
    }

    return null;
  }

  private parseRelativeHistoricalPoint(
    query: string,
    normalizedQuery?: ChatNormalizedQuery,
  ): Date | null {
    if (normalizedQuery?.timeIntent.kind !== 'historical_point') {
      const normalized = this.normalizeTelemetryText(query);
      if (
        !/\b\d+\s+(hour|hours|day|days|week|weeks|month|months)\s+ago\b/i.test(
          normalized,
        )
      ) {
        return null;
      }
    }

    const normalized = this.normalizeTelemetryText(query);
    const agoMatch = normalized.match(
      /\b(\d+)\s+(hour|hours|day|days|week|weeks|month|months)\s+ago\b/i,
    );
    if (!agoMatch) {
      return null;
    }

    const amount = Number.parseInt(agoMatch[1], 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    const unit = agoMatch[2].toLowerCase();
    const pointInTime = new Date();
    if (unit.startsWith('hour')) {
      pointInTime.setUTCHours(pointInTime.getUTCHours() - amount);
    }
    if (unit.startsWith('day')) {
      pointInTime.setUTCDate(pointInTime.getUTCDate() - amount);
    }
    if (unit.startsWith('week')) {
      pointInTime.setUTCDate(pointInTime.getUTCDate() - amount * 7);
    }
    if (unit.startsWith('month')) {
      pointInTime.setUTCMonth(pointInTime.getUTCMonth() - amount);
    }

    return pointInTime;
  }

  private buildDefaultHistoricalEventRange(): InfluxHistoricalQueryRange {
    const stop = new Date();
    const start = new Date(stop);
    start.setUTCMonth(start.getUTCMonth() - 6);
    return { start, stop };
  }

  private parseExplicitHistoricalDate(query: string): Date | null {
    const isoMatch = query.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (isoMatch) {
      return new Date(
        Date.UTC(
          Number.parseInt(isoMatch[1], 10),
          Number.parseInt(isoMatch[2], 10) - 1,
          Number.parseInt(isoMatch[3], 10),
        ),
      );
    }

    const monthPattern =
      /\b(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i;
    const dayMonthMatch = query.match(monthPattern);
    if (dayMonthMatch) {
      return new Date(
        Date.UTC(
          Number.parseInt(dayMonthMatch[3], 10),
          this.getHistoricalMonthIndex(dayMonthMatch[2]),
          Number.parseInt(dayMonthMatch[1], 10),
        ),
      );
    }

    const monthDayPattern =
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/i;
    const monthDayMatch = query.match(monthDayPattern);
    if (monthDayMatch) {
      return new Date(
        Date.UTC(
          Number.parseInt(monthDayMatch[3], 10),
          this.getHistoricalMonthIndex(monthDayMatch[1]),
          Number.parseInt(monthDayMatch[2], 10),
        ),
      );
    }

    return null;
  }

  private findHistoricalDateWithoutYear(query: string): string | null {
    const match = query.match(
      /\b(?:on\s+|from\s+|between\s+)?(\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))(?!\s+\d{4})\b/i,
    );
    if (match?.[1]) {
      return match[1];
    }

    const reverseMatch = query.match(
      /\b((?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2})(?!,?\s+\d{4})\b/i,
    );
    return reverseMatch?.[1] ?? null;
  }

  private parseHistoricalTimeOfDay(
    query: string,
  ): { hours: number; minutes: number } | null {
    const atClockMatch = query.match(
      /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*utc)?\b/i,
    );
    const bareClockMatch = query.match(
      /\b(\d{1,2}):(\d{2})\s*(am|pm)?(?:\s*utc)?\b/i,
    );
    const meridiemOnlyMatch = query.match(
      /\b(\d{1,2})\s*(am|pm)(?:\s*utc)?\b/i,
    );

    const hoursText =
      atClockMatch?.[1] ?? bareClockMatch?.[1] ?? meridiemOnlyMatch?.[1];
    if (!hoursText) {
      return null;
    }

    let hours = Number.parseInt(hoursText, 10);
    const minutes = Number.parseInt(
      atClockMatch?.[2] ?? bareClockMatch?.[2] ?? '0',
      10,
    );
    const meridiem = (
      atClockMatch?.[3] ??
      bareClockMatch?.[3] ??
      meridiemOnlyMatch?.[2]
    )?.toLowerCase();
    if (meridiem === 'pm' && hours < 12) {
      hours += 12;
    } else if (meridiem === 'am' && hours === 12) {
      hours = 0;
    }

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      return null;
    }

    return { hours, minutes };
  }

  private sanitizeHistoricalMetricQuery(query: string): string {
    const cleaned = query
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
      .replace(/\b\d{4}\b/g, ' ')
      .replace(
        /\b\d+\s+(?:hour|hours|day|days|week|weeks|month|months)\b/gi,
        ' ',
      )
      .replace(
        /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
        ' ',
      )
      .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
      .replace(
        /\b(?:last|past|previous|over the last|today|yesterday|this week|last week|this month|last month|between|from|to|on|at|during|for)\b/gi,
        ' ',
      )
      .replace(
        /\b(?:what|was|were|is|the|please|show|give|tell|me|how|did|explain|there|any|trend|trending|history|historical|change|changed|changes|changing|difference|different|diff|movement|moving|sharp|abrupt|abnormal|sudden|jump|jumps|spike|spikes)\b/gi,
        ' ',
      )
      .replace(/[?!,.:;()]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return cleaned || query.trim();
  }

  private pickNearestHistoricalRows(
    rows: InfluxMetricValue[],
    targetTime: Date,
  ): InfluxMetricValue[] {
    const bestByKey = new Map<string, InfluxMetricValue>();
    for (const row of rows) {
      const rowTime = Date.parse(row.time);
      if (!Number.isFinite(rowTime)) {
        continue;
      }

      const currentBest = bestByKey.get(row.key);
      if (!currentBest) {
        bestByKey.set(row.key, row);
        continue;
      }

      const bestTime = Date.parse(currentBest.time);
      if (
        Math.abs(rowTime - targetTime.getTime()) <
        Math.abs(bestTime - targetTime.getTime())
      ) {
        bestByKey.set(row.key, row);
      }
    }

    return [...bestByKey.values()];
  }

  private formatHistoricalMetricValue(
    entry: ShipTelemetryEntry,
    value: unknown,
  ): string {
    const numericValue = this.parseHistoricalNumericValue(value);
    if (numericValue == null) {
      return typeof value === 'string' ? value : 'unavailable';
    }

    const unit = this.getTelemetryDisplayUnit(entry);
    return `${this.formatAggregateNumber(numericValue)}${unit ? ` ${unit}` : ''}`;
  }

  private parseHistoricalNumericValue(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return null;
  }

  private isHistoricalQueryTimeout(error: Error): boolean {
    const haystack = `${error.name} ${error.message}`;
    return (
      /RequestTimedOutError/i.test(haystack) ||
      /\brequest timed out\b/i.test(haystack)
    );
  }

  private extractHistoricalCoordinatePair(rows: InfluxMetricValue[]): {
    latitude: number;
    longitude: number;
    time: Date;
  } | null {
    const latitudeRow = rows.find((row) =>
      /\b(lat|latitude)\b/i.test(row.field),
    );
    const longitudeRow = rows.find((row) =>
      /\b(lon|longitude)\b/i.test(row.field),
    );

    if (!latitudeRow || !longitudeRow) {
      return null;
    }

    const latitude = this.parseHistoricalNumericValue(latitudeRow.value);
    const longitude = this.parseHistoricalNumericValue(longitudeRow.value);
    const latitudeTime = Date.parse(latitudeRow.time);
    const longitudeTime = Date.parse(longitudeRow.time);
    if (
      latitude == null ||
      longitude == null ||
      !Number.isFinite(latitudeTime) ||
      !Number.isFinite(longitudeTime)
    ) {
      return null;
    }

    return {
      latitude,
      longitude,
      time: new Date(Math.max(latitudeTime, longitudeTime)),
    };
  }

  private isSameCoordinateArea(
    left: { latitude: number; longitude: number },
    right: { latitude: number; longitude: number },
  ): boolean {
    return (
      Math.abs(left.latitude - right.latitude) <= 0.0005 &&
      Math.abs(left.longitude - right.longitude) <= 0.0005
    );
  }

  private getConsistentHistoricalUnit(
    entries: ShipTelemetryEntry[],
  ): string | null {
    const units = [
      ...new Set(
        entries
          .map((entry) => this.getTelemetryDisplayUnit(entry))
          .filter(Boolean),
      ),
    ];
    if (units.length !== 1) {
      return null;
    }

    const [unit] = units;
    if (!unit) {
      return null;
    }

    return unit;
  }

  private getHistoricalPositiveDeltaThreshold(
    entry: ShipTelemetryEntry,
  ): number {
    const unit = this.getTelemetryDisplayUnit(entry);
    if (unit === '%') {
      return 1;
    }

    return 20;
  }

  private getTelemetryDisplayUnit(entry: ShipTelemetryEntry): string | null {
    const explicitUnit = entry.unit?.trim();
    if (explicitUnit) {
      return this.normalizeTelemetryDisplayUnit(explicitUnit);
    }

    const sourceText = `${entry.field ?? ''} ${entry.label ?? ''}`.trim();
    if (!sourceText) {
      return null;
    }

    if (/%/.test(sourceText)) {
      return '%';
    }

    const match = sourceText.match(/\(([^)]+)\)/);
    if (!match?.[1]) {
      return null;
    }

    return this.normalizeTelemetryDisplayUnit(match[1]);
  }

  private normalizeTelemetryDisplayUnit(unit: string): string | null {
    const trimmed = unit.trim();
    if (!trimmed) {
      return null;
    }

    if (/^l$/i.test(trimmed) || /^lit(er|re)s?$/i.test(trimmed)) {
      return 'liters';
    }

    if (/%/.test(trimmed)) {
      return '%';
    }

    if (/^kw$/i.test(trimmed)) {
      return 'kW';
    }

    if (/^nm$/i.test(trimmed)) {
      return 'Nm';
    }

    if (/^rpm$/i.test(trimmed)) {
      return 'rpm';
    }

    if (/^c$|^°c$/i.test(trimmed)) {
      return '°C';
    }

    return trimmed;
  }

  private getHistoricalMetricSemanticKind(
    entry: ShipTelemetryEntry,
  ): 'counter' | 'coordinate' | 'state' | 'gauge' {
    const haystack = this.buildTelemetryHaystack(entry);
    if (
      /\b(latitude|longitude|lat|lon|position|gps|coordinate)\b/i.test(haystack)
    ) {
      return 'coordinate';
    }

    if (
      entry.dataType === 'boolean' ||
      /\b(status|state|alarm|fault)\b/i.test(haystack)
    ) {
      return 'state';
    }

    if (
      /\b(total fuel used|fuel used|running hours|engine hours|hour meter|runtime|cumulative|counter|accumulated)\b/i.test(
        haystack,
      )
    ) {
      return 'counter';
    }

    return 'gauge';
  }

  private buildFullDayHistoricalRange(date: Date): InfluxHistoricalQueryRange {
    return {
      start: this.startOfUtcDay(date),
      stop: this.endOfUtcDay(date),
    };
  }

  private isSingleUtcDayRange(
    range: InfluxHistoricalQueryRange | null,
  ): range is InfluxHistoricalQueryRange {
    if (!range) {
      return false;
    }

    const start =
      range.start instanceof Date ? range.start : new Date(range.start);
    const stop = range.stop instanceof Date ? range.stop : new Date(range.stop);
    return (
      start.getUTCFullYear() === stop.getUTCFullYear() &&
      start.getUTCMonth() === stop.getUTCMonth() &&
      start.getUTCDate() === stop.getUTCDate()
    );
  }

  private formatHistoricalTimestamp(date: Date): string {
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }

  private formatHistoricalDay(date: Date): string {
    return `${date.toISOString().slice(0, 10)} UTC`;
  }

  private formatHistoricalDayOrRange(
    range: InfluxHistoricalQueryRange,
  ): string {
    const start =
      range.start instanceof Date ? range.start : new Date(range.start);
    const stop = range.stop instanceof Date ? range.stop : new Date(range.stop);
    const fullDay =
      start.getTime() === this.startOfUtcDay(start).getTime() &&
      stop.getTime() === this.endOfUtcDay(start).getTime();

    if (this.isSingleUtcDayRange(range) && fullDay) {
      return this.formatHistoricalDay(start);
    }

    return this.formatHistoricalRange(range);
  }

  private formatHistoricalRange(range: InfluxHistoricalQueryRange): string {
    const start =
      range.start instanceof Date ? range.start : new Date(range.start);
    const stop = range.stop instanceof Date ? range.stop : new Date(range.stop);
    return `${this.formatHistoricalTimestamp(start)} to ${this.formatHistoricalTimestamp(stop)}`;
  }

  private startOfUtcDay(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private endOfUtcDay(date: Date): Date {
    return new Date(
      this.startOfUtcDay(date).getTime() + 24 * 60 * 60 * 1000 - 1,
    );
  }

  private startOfUtcWeek(date: Date): Date {
    const start = this.startOfUtcDay(date);
    const day = start.getUTCDay() || 7;
    start.setUTCDate(start.getUTCDate() - (day - 1));
    return start;
  }

  private startOfUtcMonth(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  }

  private endOfUtcMonth(date: Date): Date {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1,
    );
  }

  private getHistoricalMonthIndex(monthName: string): number {
    const months = [
      'january',
      'february',
      'march',
      'april',
      'may',
      'june',
      'july',
      'august',
      'september',
      'october',
      'november',
      'december',
    ];
    return Math.max(0, months.indexOf(monthName.trim().toLowerCase()));
  }

  private formatAggregateNumber(value: number): string {
    return Number.isInteger(value)
      ? value.toLocaleString('en-US')
      : value.toLocaleString('en-US', {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        });
  }

  private formatSignedAggregateNumber(value: number): string {
    const formatted = this.formatAggregateNumber(Math.abs(value));
    if (value > 0) {
      return `+${formatted}`;
    }
    if (value < 0) {
      return `-${formatted}`;
    }
    return formatted;
  }

  private isNegligibleHistoricalChange(
    delta: number,
    fromValue: number,
    toValue: number,
  ): boolean {
    const scale = Math.max(Math.abs(fromValue), Math.abs(toValue), 1);
    return Math.abs(delta) <= scale * 0.005;
  }

  private getMedianValue(values: number[]): number {
    if (values.length === 0) {
      return 0;
    }

    const middle = Math.floor(values.length / 2);
    if (values.length % 2 === 1) {
      return values[middle];
    }

    return (values[middle - 1] + values[middle]) / 2;
  }

  private toTelemetryMap(
    entries: ShipTelemetryEntry[],
  ): Record<string, string | number | boolean | null> {
    const telemetry: Record<string, string | number | boolean | null> = {};
    for (const entry of entries) {
      telemetry[this.formatTelemetryLabel(entry)] = entry.value;
    }
    return telemetry;
  }

  private formatTelemetryLabel(entry: ShipTelemetryEntry): string {
    const dedicatedTankLabel = this.getDedicatedTankDisplayLabel(entry);
    const primary =
      dedicatedTankLabel ??
      (entry.measurement && entry.field
        ? `${entry.measurement}.${entry.field}`
        : entry.label || entry.key);
    const descriptionSummary = this.getTelemetryDescriptionSummary(
      entry.description,
    );

    const extras = dedicatedTankLabel
      ? [entry.unit ? `Unit: ${entry.unit}` : ''].filter(Boolean)
      : [
          descriptionSummary,
          entry.bucket ? `Bucket: ${entry.bucket}` : '',
          entry.unit ? `Unit: ${entry.unit}` : '',
        ].filter(
          (value) =>
            value &&
            !this.containsLoosely(primary, value) &&
            !this.containsLoosely(value, primary),
        );

    return [primary, ...extras].filter(Boolean).join(' — ');
  }

  private getTelemetryDescriptionSummary(
    description?: string | null,
  ): string | null {
    if (!description?.trim()) {
      return null;
    }

    const firstLine = description
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .find(Boolean);
    if (!firstLine) {
      return null;
    }

    if (firstLine.length <= 160) {
      return firstLine;
    }

    return `${firstLine.slice(0, 157).trimEnd()}...`;
  }

  private findCompositeTelemetryEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    options?: {
      limitResults?: boolean;
      allowComposite?: boolean;
    },
  ): ShipTelemetryEntry[] {
    const componentQueries = this.buildCompositeTelemetryQueries(
      query,
    );
    if (componentQueries.length <= 1) {
      return [];
    }

    const mergedEntries: ShipTelemetryEntry[] = [];
    let matchedComponents = 0;

    for (const componentQuery of componentQueries) {
      const matchedEntries = this.findRelevantTelemetryEntries(
        entries,
        componentQuery,
        undefined,
        {
          ...options,
          allowComposite: false,
          limitResults: false,
        },
      );
      if (matchedEntries.length === 0) {
        continue;
      }

      matchedComponents += 1;
      mergedEntries.push(...matchedEntries);
    }

    if (matchedComponents < 2) {
      return [];
    }

    const uniqueEntries = this.uniqueTelemetryEntries(mergedEntries);
    return options?.limitResults === false
      ? uniqueEntries
      : uniqueEntries.slice(0, 24);
  }

  private buildCompositeTelemetryQueries(
    query: string,
  ): string[] {
    const rawQuery = query.replace(/\s+/g, ' ').trim();
    if (
      !rawQuery ||
      !/(,|;|\band\b|\bplus\b|\balong with\b|\bas well as\b|&)/i.test(
        rawQuery,
      )
    ) {
      return [];
    }

    const rawParts = rawQuery
      .split(/\s*(?:,|;|\band\b|\bplus\b|&|\balong with\b|\bas well as\b)\s*/i)
      .map((part) => part.trim())
      .filter(Boolean);
    if (rawParts.length <= 1) {
      return [];
    }

    const components = rawParts
      .map((part) => this.analyzeTelemetryQueryComponent(part))
      .filter(
        (component) =>
          component.normalized.length > 0 &&
          (component.hasMeasurementPhrase || component.hasMeaningfulSubject),
      );
    if (components.length <= 1) {
      return [];
    }

    const queries = components
      .map((component, index, all) =>
        this.buildCompositeTelemetryComponentQuery(component, index, all),
      )
      .filter(Boolean);

    const uniqueQueries: string[] = [];
    const seen = new Set<string>();
    for (const candidate of queries) {
      const normalizedCandidate = this.normalizeTelemetryText(candidate);
      if (!normalizedCandidate || seen.has(normalizedCandidate)) {
        continue;
      }

      seen.add(normalizedCandidate);
      uniqueQueries.push(candidate);
    }

    return uniqueQueries;
  }

  private analyzeTelemetryQueryComponent(
    rawPart: string,
  ): TelemetryQueryComponent {
    const raw = rawPart.trim().replace(/^[,;:]+|[,;:]+$/g, '').trim();
    const normalized = this.normalizeTelemetryText(raw);
    const orderedTokens = normalized.split(/\s+/).filter(Boolean);
    const tokenCount = orderedTokens.length;
    const measurementAnchorIndex =
      this.getTelemetryMeasurementAnchorIndex(orderedTokens);
    const measurementAnchorPhrase =
      this.extractTelemetryMeasurementAnchorPhrase(
        orderedTokens,
        measurementAnchorIndex,
      );
    const commonSubjectPhrase =
      this.extractTelemetryCommonSubjectPhrase(
        orderedTokens,
        measurementAnchorIndex,
      );
    const entityPhrase = this.extractTelemetryEntityPhrase(
      orderedTokens,
      measurementAnchorIndex,
    );
    const measurementPhrase = measurementAnchorPhrase.trim();
    const querySignals = this.buildTelemetryQuerySignals(raw);
    const subjectTokens = this.getTelemetrySubjectTokens(querySignals.tokens);
    const queryKinds = this.extractTelemetryQueryMeasurementKinds(normalized);
    const subjectPhrase = [commonSubjectPhrase, entityPhrase]
      .filter(Boolean)
      .join(' ')
      .trim();

    return {
      raw,
      normalized,
      subjectPhrase,
      commonSubjectPhrase,
      entityPhrase,
      measurementPhrase,
      measurementAnchorPhrase: measurementAnchorPhrase || measurementPhrase,
      hasMeasurementPhrase:
        Boolean(measurementPhrase) ||
        queryKinds.size > 0 ||
        this.isNavigationLocationIntent(normalized) ||
        this.isNavigationSpeedIntent(normalized),
      hasMeaningfulSubject:
        (Boolean(subjectPhrase) &&
          this.isTelemetrySubjectPhrase(subjectPhrase)) ||
        subjectTokens.some((token) => this.isTelemetrySubjectPhrase(token)),
      queryKinds,
      tokenCount,
    };
  }

  private buildCompositeTelemetryComponentQuery(
    component: TelemetryQueryComponent,
    index: number,
    components: TelemetryQueryComponent[],
  ): string {
    if (!component.raw) {
      return '';
    }

    if (
      component.hasMeasurementPhrase &&
      (component.hasMeaningfulSubject || component.tokenCount >= 3)
    ) {
      return component.raw;
    }

    const inheritedCommonSubject =
      this.findNearestCompositeTelemetryPhrase(
        components,
        index,
        'commonSubjectPhrase',
      ) ?? '';
    const inheritedMeasurementPhrase =
      this.findNearestCompositeTelemetryPhrase(
        components,
        index,
        'measurementPhrase',
      ) ?? '';
    const inheritedMeasurementAnchor =
      this.findNearestCompositeTelemetryPhrase(
        components,
        index,
        'measurementAnchorPhrase',
      ) ?? '';

    if (component.hasMeasurementPhrase) {
      if (
        !component.hasMeaningfulSubject &&
        inheritedCommonSubject &&
        component.measurementAnchorPhrase
      ) {
        return `${inheritedCommonSubject} ${component.measurementAnchorPhrase}`.trim();
      }

      return component.raw;
    }

    const localSubjectPhrase =
      component.entityPhrase || component.subjectPhrase || component.raw;
    if (!localSubjectPhrase) {
      return component.raw;
    }

    if (inheritedMeasurementAnchor) {
      const shouldUseInheritedCommonSubject =
        inheritedCommonSubject &&
        this.isTelemetryQualifierPhrase(localSubjectPhrase);
      if (shouldUseInheritedCommonSubject) {
        return `${inheritedCommonSubject} ${inheritedMeasurementAnchor} ${localSubjectPhrase}`.trim();
      }

      if (
        inheritedMeasurementPhrase &&
        inheritedMeasurementPhrase !== inheritedMeasurementAnchor
      ) {
        return `${inheritedMeasurementPhrase} ${localSubjectPhrase}`.trim();
      }

      return `${localSubjectPhrase} ${inheritedMeasurementAnchor}`.trim();
    }

    if (inheritedMeasurementPhrase) {
      return `${inheritedMeasurementPhrase} ${localSubjectPhrase}`.trim();
    }

    return component.raw;
  }

  private findNearestCompositeTelemetryPhrase(
    components: TelemetryQueryComponent[],
    index: number,
    field:
      | 'commonSubjectPhrase'
      | 'measurementPhrase'
      | 'measurementAnchorPhrase',
  ): string | null {
    for (let offset = 1; offset < components.length; offset += 1) {
      const backward = components[index - offset];
      if (backward?.[field]) {
        return backward[field];
      }

      const forward = components[index + offset];
      if (forward?.[field]) {
        return forward[field];
      }
    }

    return null;
  }

  private getTelemetryMeasurementAnchorIndex(tokens: string[]): number {
    return tokens.findIndex((token, index) => {
      if (!this.isTelemetryMeasurementAnchorToken(token)) {
        return false;
      }

      if (token !== 'current') {
        return true;
      }

      return !this.isTelemetryCurrentQualifierToken(tokens, index);
    });
  }

  private extractTelemetryMeasurementAnchorPhrase(
    tokens: string[],
    anchorIndex: number,
  ): string {
    if (anchorIndex < 0) {
      return '';
    }

    const anchorToken = tokens[anchorIndex];
    const parts: string[] = [];
    const previousToken = tokens[anchorIndex - 1];
    if (
      previousToken &&
      this.shouldIncludePreviousTokenInTelemetryMeasurementPhrase(
        previousToken,
        anchorToken,
      )
    ) {
      parts.push(previousToken);
    }

    parts.push(anchorToken);
    return parts.join(' ').trim();
  }

  private extractTelemetryCommonSubjectPhrase(
    tokens: string[],
    anchorIndex: number,
  ): string {
    if (anchorIndex < 0) {
      return '';
    }

    const measurementStartsAt =
      anchorIndex > 0 &&
      this.shouldIncludePreviousTokenInTelemetryMeasurementPhrase(
        tokens[anchorIndex - 1],
        tokens[anchorIndex],
      )
        ? anchorIndex - 1
        : anchorIndex;
    return tokens
      .slice(0, measurementStartsAt)
      .filter((token) => !this.isTelemetryClauseFillerToken(token))
      .join(' ')
      .trim();
  }

  private extractTelemetryEntityPhrase(
    tokens: string[],
    anchorIndex: number,
  ): string {
    const searchTokens =
      anchorIndex >= 0 ? tokens.slice(anchorIndex + 1) : tokens.slice();
    return searchTokens
      .filter((token) => !this.isTelemetryClauseFillerToken(token))
      .join(' ')
      .trim();
  }

  private isTelemetryMeasurementAnchorToken(token: string): boolean {
    const normalizedToken = this.normalizeTelemetryToken(token);
    return new Set([
      'temperature',
      'pressure',
      'voltage',
      'current',
      'load',
      'power',
      'energy',
      'speed',
      'flow',
      'rate',
      'runtime',
      'hour',
      'hours',
      'status',
      'state',
      'alarm',
      'warning',
      'fault',
      'trip',
      'level',
      'levels',
      'location',
      'position',
      'coordinate',
      'coordinates',
      'gps',
      'latitude',
      'longitude',
      'lat',
      'lon',
    ]).has(normalizedToken);
  }

  private isTelemetryCurrentQualifierToken(
    tokens: string[],
    index: number,
  ): boolean {
    if (tokens[index] !== 'current') {
      return false;
    }

    return tokens.some(
      (token, tokenIndex) =>
        tokenIndex > index &&
        this.isTelemetryMeasurementAnchorToken(token) &&
        token !== 'current',
    );
  }

  private shouldIncludePreviousTokenInTelemetryMeasurementPhrase(
    previousToken: string,
    anchorToken: string,
  ): boolean {
    if (!previousToken || !anchorToken) {
      return false;
    }

    const normalizedPreviousToken =
      this.normalizeTelemetryToken(previousToken);
    const normalizedAnchorToken = this.normalizeTelemetryToken(anchorToken);

    if (normalizedAnchorToken === 'speed') {
      return new Set(['fan', 'wind']).has(normalizedPreviousToken);
    }

    if (normalizedAnchorToken === 'position') {
      return new Set(['throttle', 'rudder']).has(normalizedPreviousToken);
    }

    return false;
  }

  private isTelemetryClauseFillerToken(token: string): boolean {
    return new Set([
      'a',
      'an',
      'and',
      'any',
      'are',
      'at',
      'current',
      'currently',
      'for',
      'from',
      'how',
      'in',
      'is',
      'latest',
      'me',
      'now',
      'of',
      'on',
      'only',
      'our',
      'please',
      'right',
      'show',
      'tell',
      'the',
      'their',
      'there',
      'these',
      'this',
      'what',
      'where',
      'which',
      'with',
      'yacht',
    ]).has(token);
  }

  private isTelemetryQualifierPhrase(value: string): boolean {
    const tokens = this.normalizeTelemetryText(value)
      .split(/\s+/)
      .filter(Boolean)
      .filter((token) => !this.isTelemetryClauseFillerToken(token));
    if (tokens.length === 0) {
      return false;
    }

    return tokens.every((token) =>
      new Set([
        'aft',
        'bridge',
        'cabin',
        'captain',
        'corridor',
        'crew',
        'deck',
        'engine',
        'fwd',
        'forward',
        'galley',
        'garage',
        'left',
        'lower',
        'mess',
        'mid',
        'port',
        'right',
        'room',
        'salon',
        'starboard',
        'stbd',
        'upper',
      ]).has(token),
    );
  }

  private isTelemetrySubjectPhrase(value: string): boolean {
    if (!value.trim()) {
      return false;
    }

    const normalized = this.normalizeTelemetryText(value);
    if (this.isTelemetryQualifierPhrase(normalized)) {
      return true;
    }

    return /\b(alarm|battery|bilge|blower|bridge|cabin|compressor|coolant|corridor|crew|current|depth|engine|fan|flow|fuel|galley|garage|generator|genset|gps|hvac|level|load|location|longitude|latitude|mess|motor|oil|position|power|pressure|pump|rate|room|rpm|rudder|salon|sensor|speed|status|tank|temperature|throttle|trip|voltage|warning|water|wind)\b/i.test(
      normalized,
    );
  }

  private findRelevantTelemetryEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
    options?: {
      limitResults?: boolean;
      allowComposite?: boolean;
    },
  ): ShipTelemetryEntry[] {
    const navigationMotionEntries = this.findNavigationMotionTelemetryEntries(
      entries,
      query,
      resolvedSubjectQuery,
    );
    if (navigationMotionEntries.length > 0) {
      return navigationMotionEntries;
    }

    if (options?.allowComposite !== false) {
      const compositeEntries = this.findCompositeTelemetryEntries(
        entries,
        query,
        options,
      );
      if (compositeEntries.length > 0) {
        return compositeEntries;
      }
    }

    const aggregateTankEntries = this.findAggregateTankTelemetryEntries(
      entries,
      query,
      resolvedSubjectQuery,
    );
    if (aggregateTankEntries.length > 0) {
      return aggregateTankEntries;
    }

    const tankInventoryEntries = this.findDirectTankInventoryTelemetryEntries(
      entries,
      query,
      resolvedSubjectQuery,
    );
    if (tankInventoryEntries.length > 0) {
      return tankInventoryEntries;
    }

    if (this.shouldUseLocationTelemetryShortcut(query, resolvedSubjectQuery)) {
      const locationEntries = this.findLocationTelemetryEntries(
        entries,
        query,
        resolvedSubjectQuery,
      );
      if (locationEntries.length > 0) {
        return locationEntries;
      }
    }

    const querySignals = this.buildTelemetryQuerySignals(
      query,
      resolvedSubjectQuery,
    );
    if (
      !querySignals.normalizedQuery &&
      querySignals.tokens.length === 0 &&
      querySignals.phrases.length === 0
    ) {
      return [];
    }

    const scored = this.getScoredTelemetryEntries(entries, querySignals);
    const narrowed = this.filterTelemetryCandidatesByQuery(
      scored,
      querySignals,
    );

    if (narrowed.length === 0) {
      return [];
    }

    const filteredEntries = this.ensureBestTelemetryKindCoverage(
      this.filterScoredTelemetryEntries(narrowed),
      narrowed,
      querySignals.normalizedQuery,
    ).map((candidate) => candidate.entry);
    const expandedAlarmFamilyEntries =
      this.expandDominantAlarmTelemetryFamilyEntries(
        narrowed.map((candidate) => candidate.entry),
        filteredEntries,
        query,
        resolvedSubjectQuery,
      );
    if (expandedAlarmFamilyEntries.length > 0) {
      return expandedAlarmFamilyEntries;
    }

    return options?.limitResults === false ||
      this.shouldExpandFullAlarmTelemetryMatches(
        filteredEntries,
        query,
        resolvedSubjectQuery,
      )
      ? filteredEntries
      : filteredEntries.slice(0, 12);
  }

  private expandDominantAlarmTelemetryFamilyEntries(
    candidateEntries: ShipTelemetryEntry[],
    selectedEntries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): ShipTelemetryEntry[] {
    if (!this.isAlarmInventoryTelemetryQuery(query, resolvedSubjectQuery)) {
      return [];
    }

    const selectedAlarmEntries = selectedEntries.filter((entry) =>
      this.isAlarmStatusTelemetryEntry(entry),
    );
    if (selectedAlarmEntries.length < 2) {
      return [];
    }

    const familyCounts = new Map<string, number>();
    for (const entry of selectedAlarmEntries) {
      const familyKey = this.getAlarmTelemetryFamilyKey(entry);
      if (!familyKey) {
        continue;
      }
      familyCounts.set(familyKey, (familyCounts.get(familyKey) ?? 0) + 1);
    }

    const dominantFamily = [...familyCounts.entries()].sort(
      (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
    )[0];
    if (!dominantFamily) {
      return [];
    }

    const [dominantFamilyKey, dominantCount] = dominantFamily;
    if (
      dominantCount < Math.max(2, Math.ceil(selectedAlarmEntries.length * 0.6))
    ) {
      return [];
    }

    const expandedFamilyEntries = candidateEntries.filter((entry) => {
      if (!this.isAlarmStatusTelemetryEntry(entry)) {
        return false;
      }
      return this.getAlarmTelemetryFamilyKey(entry) === dominantFamilyKey;
    });

    const expandsSelectedAlarmFamily =
      expandedFamilyEntries.length > selectedAlarmEntries.length;
    const trimsNonAlarmNoise =
      expandedFamilyEntries.length < selectedEntries.length;
    if (
      (!expandsSelectedAlarmFamily && !trimsNonAlarmNoise) ||
      expandedFamilyEntries.length > 64
    ) {
      return [];
    }

    return [...expandedFamilyEntries].sort(
      (left, right) =>
        this.getAlarmTelemetrySequence(left) -
          this.getAlarmTelemetrySequence(right) ||
        left.key.localeCompare(right.key),
    );
  }

  private shouldExpandFullAlarmTelemetryMatches(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): boolean {
    if (entries.length <= 12 || entries.length > 64) {
      return false;
    }

    return this.isAlarmInventoryTelemetryQuery(query, resolvedSubjectQuery)
      ? entries.every((entry) => this.isAlarmStatusTelemetryEntry(entry))
      : false;
  }

  private isAlarmInventoryTelemetryQuery(
    query: string,
    resolvedSubjectQuery?: string,
  ): boolean {
    const searchSpace = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    if (!/\balarm|alarms\b/i.test(searchSpace)) {
      return false;
    }

    const queryKinds = this.extractTelemetryQueryMeasurementKinds(searchSpace);
    const telemetryListRequest = this.parseTelemetryListRequest(
      query,
      resolvedSubjectQuery,
    );
    const asksForAlarmInventory =
      telemetryListRequest?.mode === 'full' ||
      queryKinds.has('status') ||
      /\b(active|inactive|enabled|disabled|online|offline|show|list|which|what|any|all|available|complete|entire|every|historical|history|now|right now|current|currently)\b/i.test(
        searchSpace,
      );
    if (!asksForAlarmInventory) {
      return false;
    }

    return true;
  }

  private isAlarmStatusTelemetryEntry(entry: ShipTelemetryEntry): boolean {
    const haystack = this.buildTelemetryHaystack(entry);
    return (
      /\balarm\b/i.test(haystack) &&
      (entry.dataType === 'boolean' ||
        this.extractTelemetryEntryMeasurementKinds(entry).has('status') ||
        /\b(status|state)\b/i.test(haystack))
    );
  }

  private getAlarmTelemetryFamilyKey(entry: ShipTelemetryEntry): string | null {
    const measurementRoot = this.normalizeAlarmTelemetryFamilySegment(
      entry.measurement ?? entry.label ?? '',
    );
    const fieldRoot = this.normalizeAlarmTelemetryFieldSegment(
      entry.field ?? entry.label ?? '',
    );

    if (!fieldRoot || !/\balarm\b/i.test(fieldRoot)) {
      return null;
    }

    return `${measurementRoot || 'alarm'}|${fieldRoot}`;
  }

  private normalizeAlarmTelemetryFamilySegment(value: string): string {
    return this.normalizeTelemetryText(value)
      .replace(/\b([a-z]+)\d+\b/g, '$1')
      .replace(/\b\d+\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeAlarmTelemetryFieldSegment(value: string): string {
    return this.normalizeTelemetryText(value)
      .replace(/\b\d+\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getAlarmTelemetrySequence(entry: ShipTelemetryEntry): number {
    const rawValue = [
      entry.field,
      entry.label,
      entry.key,
      entry.measurement,
      entry.description,
    ]
      .filter(Boolean)
      .join(' ');
    const match = rawValue.match(
      /\b(?:alarm|warning|fault|trip)\D{0,6}(\d{1,3})\b/i,
    );
    return match ? Number.parseInt(match[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  private shouldUseLocationTelemetryShortcut(
    query: string,
    resolvedSubjectQuery?: string,
  ): boolean {
    const searchSpace = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    if (!this.isTelemetryLocationQuery(searchSpace)) {
      return false;
    }

    const queryKinds = this.extractTelemetryQueryMeasurementKinds(searchSpace);
    queryKinds.delete('location');
    return queryKinds.size === 0;
  }

  private findNavigationMotionTelemetryEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): ShipTelemetryEntry[] {
    const intent = this.detectNavigationMotionTelemetryIntent(
      query,
      resolvedSubjectQuery,
    );
    if (!intent) {
      return [];
    }

    const searchSpace = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    const speedIndex = this.getNavigationSpeedIntentIndex(searchSpace);
    const locationIndex = this.getNavigationLocationIntentIndex(searchSpace);
    const speedFirst =
      intent.wantsSpeed &&
      (!intent.wantsLocation ||
        (speedIndex >= 0 &&
          (locationIndex < 0 || speedIndex <= locationIndex)));
    const speedEntries = intent.wantsSpeed
      ? this.findVesselNavigationSpeedEntries(
          entries,
          intent.preferredSpeedKind,
        )
      : [];
    const locationEntries = intent.wantsLocation
      ? this.findCurrentVesselCoordinateEntries(entries)
      : [];
    const windEntries = intent.wantsWind
      ? this.findWindTelemetryEntries(entries)
      : [];
    const selected = speedFirst
      ? [...speedEntries, ...locationEntries, ...windEntries]
      : [...locationEntries, ...speedEntries, ...windEntries];

    return this.uniqueTelemetryEntries(selected);
  }

  private detectNavigationMotionTelemetryIntent(
    query: string,
    resolvedSubjectQuery?: string,
  ): NavigationMotionTelemetryIntent | null {
    const searchSpace = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    const queryKinds = this.extractTelemetryQueryMeasurementKinds(searchSpace);
    const requestedKinds = [...queryKinds].filter(
      (kind) => kind !== 'location' && kind !== 'speed',
    );
    if (requestedKinds.length > 0) {
      return null;
    }

    const wantsLocation = this.isNavigationLocationIntent(searchSpace);
    const wantsWind = this.isWindTelemetryIntent(searchSpace);
    const windOwnsSpeed =
      wantsWind &&
      !wantsLocation &&
      !this.hasVesselNavigationContext(searchSpace) &&
      (/\bwind\s+(?:speed|direction|angle)\b/i.test(searchSpace) ||
        /\b(?:speed|direction|angle)\s+(?:of|for|in|on)\s+(?:the\s+)?wind\b/i.test(
          searchSpace,
        ));
    const wantsSpeed =
      this.isNavigationSpeedIntent(searchSpace) && !windOwnsSpeed;
    if (!wantsLocation && !wantsSpeed && !wantsWind) {
      return null;
    }

    if (wantsSpeed && this.hasNonNavigationPrimarySpeedSubject(searchSpace)) {
      return null;
    }

    if (
      !wantsLocation &&
      !this.hasVesselNavigationContext(searchSpace) &&
      !/\b(we|our)\b/i.test(searchSpace)
    ) {
      return null;
    }

    return {
      wantsLocation,
      wantsSpeed,
      wantsWind,
      preferredSpeedKind: this.getPreferredNavigationSpeedKind(searchSpace),
    };
  }

  private isNavigationLocationIntent(normalizedQuery: string): boolean {
    return (
      this.isTelemetryLocationQuery(normalizedQuery) ||
      /\bwhere\s+(?:are\s+we|am\s+i)\b/i.test(normalizedQuery)
    );
  }

  private isNavigationSpeedIntent(normalizedQuery: string): boolean {
    return (
      /\b(speed|sog|stw|vmg|knots?|kts?)\b/i.test(normalizedQuery) ||
      /\bhow\s+fast\b/i.test(normalizedQuery) ||
      /\b(?:are\s+we|we\s+are|vessel\s+is|yacht\s+is|ship\s+is|boat\s+is)\s+(?:moving|sailing|underway)\b/i.test(
        normalizedQuery,
      )
    );
  }

  private hasVesselNavigationContext(normalizedQuery: string): boolean {
    return /\b(yacht|vessel|ship|boat|navigation|nav|gps|position|location|coordinates?|latitude|longitude|lat|lon|sog|stw|vmg)\b/i.test(
      normalizedQuery,
    );
  }

  private hasNonNavigationPrimarySpeedSubject(
    normalizedQuery: string,
  ): boolean {
    return (
      /\b(wind|fan|blower|hvac|pump|compressor|engine|genset|generator|motor|throttle|shaft|propeller|rudder)\s+(?:speed|rpm|position)\b/i.test(
        normalizedQuery,
      ) ||
      /\b(?:speed|rpm|position)\s+(?:of|for|in|on)\s+(?:the\s+)?(?:wind|fan|blower|hvac|pump|compressor|engine|genset|generator|motor|throttle|shaft|propeller|rudder)\b/i.test(
        normalizedQuery,
      )
    );
  }

  private getPreferredNavigationSpeedKind(
    normalizedQuery: string,
  ): 'sog' | 'stw' | 'vmg' | undefined {
    if (/\b(?:speed\s+over\s+ground|sog)\b/i.test(normalizedQuery)) {
      return 'sog';
    }
    if (
      /\b(?:speed\s+through\s+water|stw|water\s+speed)\b/i.test(normalizedQuery)
    ) {
      return 'stw';
    }
    if (/\b(?:velocity\s+made\s+good|vmg)\b/i.test(normalizedQuery)) {
      return 'vmg';
    }
    return undefined;
  }

  private getNavigationSpeedIntentIndex(normalizedQuery: string): number {
    const match = normalizedQuery.match(
      /\b(speed|sog|stw|vmg|how\s+fast|moving|sailing|underway)\b/i,
    );
    return match?.index ?? -1;
  }

  private getNavigationLocationIntentIndex(normalizedQuery: string): number {
    const match = normalizedQuery.match(
      /\b(latitude|longitude|lat|lon|coordinates?|position|gps|location|where\s+(?:is|are))\b/i,
    );
    return match?.index ?? -1;
  }

  private findCurrentVesselCoordinateEntries(
    entries: ShipTelemetryEntry[],
  ): ShipTelemetryEntry[] {
    const candidates = entries
      .filter((entry) => this.isCurrentVesselCoordinateEntry(entry))
      .map((entry) => ({
        entry,
        score: this.scoreCurrentVesselCoordinateEntry(entry),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.entry.key.localeCompare(right.entry.key),
      );

    const selected: ShipTelemetryEntry[] = [];
    const seen = new Set<'latitude' | 'longitude'>();

    for (const candidate of candidates) {
      const kinds = this.getExplicitTelemetryCoordinateKinds(candidate.entry);
      if (kinds.has('latitude') && !seen.has('latitude')) {
        selected.push(candidate.entry);
        seen.add('latitude');
      }
      if (kinds.has('longitude') && !seen.has('longitude')) {
        selected.push(candidate.entry);
        seen.add('longitude');
      }
      if (seen.has('latitude') && seen.has('longitude')) {
        break;
      }
    }

    return selected;
  }

  private isCurrentVesselCoordinateEntry(entry: ShipTelemetryEntry): boolean {
    const exactText = this.normalizeTelemetryText(
      [entry.key, entry.label, entry.measurement, entry.field]
        .filter(Boolean)
        .join(' '),
    );
    const kinds = this.getExplicitTelemetryCoordinateKinds(entry);

    return (
      kinds.size > 0 &&
      /\b(navigation|gps|nmea|position)\b/i.test(exactText) &&
      !this.isRouteWaypointPositionEntry(entry)
    );
  }

  private isRouteWaypointPositionEntry(entry: ShipTelemetryEntry): boolean {
    const haystack = this.buildTelemetryHaystack(entry);
    return /\b(course\s+great\s+circle|course\s+rhumbline|next\s+point|previous\s+point|waypoint|route|destination|origin)\b/i.test(
      haystack,
    );
  }

  private scoreCurrentVesselCoordinateEntry(entry: ShipTelemetryEntry): number {
    const exactText = this.normalizeTelemetryText(
      [entry.key, entry.label, entry.measurement, entry.field]
        .filter(Boolean)
        .join(' '),
    );
    let score = 0;
    if (/\bnavigation\s+position\b/i.test(exactText)) score += 100;
    if (/\bnavigation\b/i.test(exactText)) score += 40;
    if (/\b(position|gps)\b/i.test(exactText)) score += 25;
    if (/\b(latitude|longitude|lat|lon)\b/i.test(exactText)) score += 20;
    if (entry.dataType === 'numeric' || typeof entry.value === 'number') {
      score += 10;
    }
    return score;
  }

  private findVesselNavigationSpeedEntries(
    entries: ShipTelemetryEntry[],
    preferredSpeedKind?: 'sog' | 'stw' | 'vmg',
  ): ShipTelemetryEntry[] {
    const candidates = entries
      .filter((entry) =>
        this.isVesselNavigationSpeedEntry(entry, preferredSpeedKind),
      )
      .map((entry) => ({
        entry,
        score: this.scoreVesselNavigationSpeedEntry(entry, preferredSpeedKind),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.entry.key.localeCompare(right.entry.key),
      );

    return candidates.slice(0, 1).map((candidate) => candidate.entry);
  }

  private isVesselNavigationSpeedEntry(
    entry: ShipTelemetryEntry,
    preferredSpeedKind?: 'sog' | 'stw' | 'vmg',
  ): boolean {
    const haystack = this.buildTelemetryHaystack(entry);
    if (
      /\b(wind|fan|blower|hvac|throttle|rpm|engine|generator|genset|pump|motor|shaft|compressor|cabin|room)\b/i.test(
        haystack,
      )
    ) {
      return false;
    }

    if (preferredSpeedKind) {
      return this.getNavigationSpeedKind(entry) === preferredSpeedKind;
    }

    return (
      /\b(navigation|nmea|performance|vessel|ship|boat|yacht)\b/i.test(
        haystack,
      ) &&
      /\b(speed\s+over\s+ground|sog|speed\s+through\s+water|stw|velocity\s+made\s+good|vmg|speed)\b/i.test(
        haystack,
      )
    );
  }

  private getNavigationSpeedKind(
    entry: ShipTelemetryEntry,
  ): 'sog' | 'stw' | 'vmg' | 'speed' | null {
    const haystack = this.buildTelemetryHaystack(entry);
    if (/\b(speed\s+over\s+ground|sog)\b/i.test(haystack)) {
      return 'sog';
    }
    if (/\b(speed\s+through\s+water|stw|water\s+speed)\b/i.test(haystack)) {
      return 'stw';
    }
    if (/\b(velocity\s+made\s+good|vmg)\b/i.test(haystack)) {
      return 'vmg';
    }
    if (/\bspeed\b/i.test(haystack)) {
      return 'speed';
    }
    return null;
  }

  private scoreVesselNavigationSpeedEntry(
    entry: ShipTelemetryEntry,
    preferredSpeedKind?: 'sog' | 'stw' | 'vmg',
  ): number {
    const haystack = this.buildTelemetryHaystack(entry);
    const kind = this.getNavigationSpeedKind(entry);
    let score =
      kind === 'sog'
        ? 120
        : kind === 'stw'
          ? 95
          : kind === 'vmg'
            ? 55
            : kind === 'speed'
              ? 40
              : 0;
    if (preferredSpeedKind && kind === preferredSpeedKind) score += 80;
    if (/\bnavigation\b/i.test(haystack)) score += 40;
    if (/\bnmea\b/i.test(haystack)) score += 15;
    if (/\b(kn|knot|knots|kts)\b/i.test(haystack)) score += 10;
    if (entry.dataType === 'numeric' || typeof entry.value === 'number') {
      score += 10;
    }
    return score;
  }

  private isWindTelemetryIntent(normalizedQuery: string): boolean {
    return (
      /\bwind\b/i.test(normalizedQuery) &&
      !/\b(window|windlass|winding|spare|part|parts|manual|procedure)\b/i.test(
        normalizedQuery,
      )
    );
  }

  private findWindTelemetryEntries(
    entries: ShipTelemetryEntry[],
  ): ShipTelemetryEntry[] {
    return entries
      .filter((entry) => this.isWindTelemetryEntry(entry))
      .map((entry) => ({
        entry,
        score: this.scoreWindTelemetryEntry(entry),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.entry.key.localeCompare(right.entry.key),
      )
      .slice(0, 6)
      .map((candidate) => candidate.entry);
  }

  private isWindTelemetryEntry(entry: ShipTelemetryEntry): boolean {
    const haystack = this.buildTelemetryIdentityHaystack(entry);
    return /\bwind\b/i.test(haystack);
  }

  private scoreWindTelemetryEntry(entry: ShipTelemetryEntry): number {
    const haystack = this.buildTelemetryIdentityHaystack(entry);
    let score = 0;
    if (/\benvironment\s+wind\b/i.test(haystack)) score += 80;
    if (/\bnmea\b/i.test(haystack)) score += 25;
    if (/\bspeed\s+(?:true|apparent|over\s+ground)\b/i.test(haystack)) {
      score += 60;
    }
    if (/\bdirection\s+(?:true|magnetic)\b/i.test(haystack)) {
      score += 50;
    }
    if (/\bangle\b/i.test(haystack)) score += 35;
    if (/\bspeed\b/i.test(haystack)) score += 20;
    if (entry.dataType === 'numeric' || typeof entry.value === 'number') {
      score += 10;
    }
    return score;
  }

  private uniqueTelemetryEntries(
    entries: ShipTelemetryEntry[],
  ): ShipTelemetryEntry[] {
    const selected: ShipTelemetryEntry[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.key)) {
        continue;
      }
      selected.push(entry);
      seen.add(entry.key);
    }
    return selected;
  }

  private findAggregateTankTelemetryEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
    options?: {
      strictDedicatedTankStorage?: boolean;
    },
  ): ShipTelemetryEntry[] {
    const searchSpace = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    const subject = this.detectStoredFluidSubject(searchSpace);
    if (!subject || !this.isAggregateStoredFluidQuery(searchSpace, subject)) {
      return [];
    }

    const selected = entries
      .filter((entry) =>
        options?.strictDedicatedTankStorage
          ? this.isHistoricalAggregateTankStorageEntry(entry, subject)
          : this.isDirectTankStorageEntry(entry, subject),
      )
      .sort((left, right) => {
        const tankRank =
          this.getTelemetryTankOrder(left) - this.getTelemetryTankOrder(right);
        return tankRank || left.key.localeCompare(right.key);
      });

    return selected.slice(0, 16);
  }

  private findDirectTankInventoryTelemetryEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): ShipTelemetryEntry[] {
    const searchSpace = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    const subject = this.detectStoredFluidSubject(searchSpace);
    if (
      !subject ||
      !this.isDirectStoredFluidInventoryQuery(searchSpace, subject)
    ) {
      return [];
    }

    const selected = entries
      .filter((entry) => this.isDirectTankStorageEntry(entry, subject))
      .sort((left, right) => {
        const tankRank =
          this.getTelemetryTankOrder(left) - this.getTelemetryTankOrder(right);
        return tankRank || left.key.localeCompare(right.key);
      });

    return selected.slice(0, 16);
  }

  private findLocationTelemetryEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): ShipTelemetryEntry[] {
    const searchSpace = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    if (!this.isTelemetryLocationQuery(searchSpace)) {
      return [];
    }

    const querySignals = this.buildTelemetryQuerySignals(
      query,
      resolvedSubjectQuery,
    );
    const scored = this.getScoredTelemetryEntries(entries, querySignals)
      .filter(
        (candidate) =>
          this.getTelemetryCoordinateKinds(candidate.entry).size > 0,
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.entry.key.localeCompare(right.entry.key),
      );

    if (scored.length === 0) {
      return [];
    }

    const explicitCoordinateScored = scored.filter(
      (candidate) =>
        this.getExplicitTelemetryCoordinateKinds(candidate.entry).size > 0,
    );
    const useExplicitCoordinateEntries =
      explicitCoordinateScored.length > 0 &&
      this.hasCoordinatePair(
        explicitCoordinateScored.map((candidate) => candidate.entry),
        (entry) => this.getExplicitTelemetryCoordinateKinds(entry),
      );
    const coordinateCandidates = useExplicitCoordinateEntries
      ? explicitCoordinateScored
      : scored;
    const coordinateKindsForEntry = (
      entry: ShipTelemetryEntry,
    ): Set<'latitude' | 'longitude'> =>
      useExplicitCoordinateEntries
        ? this.getExplicitTelemetryCoordinateKinds(entry)
        : this.getTelemetryCoordinateKinds(entry);

    const wantsLatitude = /\b(latitude|lat)\b/i.test(searchSpace);
    const wantsLongitude = /\b(longitude|lon)\b/i.test(searchSpace);

    if (wantsLatitude && !wantsLongitude) {
      return coordinateCandidates
        .filter((candidate) =>
          coordinateKindsForEntry(candidate.entry).has('latitude'),
        )
        .slice(0, 1)
        .map((candidate) => candidate.entry);
    }

    if (wantsLongitude && !wantsLatitude) {
      return coordinateCandidates
        .filter((candidate) =>
          coordinateKindsForEntry(candidate.entry).has('longitude'),
        )
        .slice(0, 1)
        .map((candidate) => candidate.entry);
    }

    const selected: ShipTelemetryEntry[] = [];
    const seen = new Set<'latitude' | 'longitude'>();

    for (const candidate of coordinateCandidates) {
      const kinds = coordinateKindsForEntry(candidate.entry);
      if (kinds.has('latitude') && !seen.has('latitude')) {
        selected.push(candidate.entry);
        seen.add('latitude');
      }
      if (kinds.has('longitude') && !seen.has('longitude')) {
        selected.push(candidate.entry);
        seen.add('longitude');
      }
      if (seen.has('latitude') && seen.has('longitude')) {
        break;
      }
    }

    return selected;
  }

  private findTelemetryFallbackEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): ShipTelemetryEntry[] {
    const searchSpace = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    const querySignals = this.buildTelemetryQuerySignals(
      query,
      resolvedSubjectQuery,
    );
    const subjectTokens = this.getTelemetrySubjectTokens(querySignals.tokens);
    const queryKinds = this.extractTelemetryQueryMeasurementKinds(searchSpace);
    const wantsHours =
      /\b(hours?|runtime|running|hour\s*meter|operating)\b/i.test(searchSpace);
    const wantsCurrentValue = queryKinds.size > 0;

    const filtered = entries.filter((entry) => {
      const haystack = this.buildTelemetryHaystack(entry);
      if (!this.matchesTelemetrySpecificContext(entry, searchSpace)) {
        return false;
      }
      const matchesSubject =
        subjectTokens.length === 0 ||
        subjectTokens.some((token) => haystack.includes(token));
      if (!matchesSubject) {
        return false;
      }

      if (wantsHours) {
        return /\b(hours?|runtime|running|operating|hour\s*meter)\b/i.test(
          haystack,
        );
      }
      if (wantsCurrentValue) {
        const entryKinds = this.extractTelemetryEntryMeasurementKinds(entry);
        return [...queryKinds].some((kind) => entryKinds.has(kind));
      }
      return false;
    });

    if (filtered.length === 0 && this.hasStrictTelemetryContext(searchSpace)) {
      return [];
    }

    return filtered.slice(0, 8);
  }

  private parseTelemetryListRequest(
    query: string,
    resolvedSubjectQuery?: string,
  ): TelemetryListRequest | null {
    const normalized = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    const asksForInventory =
      /\b(show|display|give|return|output|write|provide|enumerate)\b/i.test(
        normalized,
      ) ||
      /^\s*list\b/i.test(normalized) ||
      /\b(?:can|could|would|will|please)\s+(?:you\s+)?list\b/i.test(
        normalized,
      ) ||
      /\blist\s+of\b/i.test(normalized) ||
      /\b(all|available|full|complete|entire|every|random|\d{1,2})\b/i.test(
        normalized,
      );
    const mentionsTelemetryInventory =
      /\b(metrics?|telemetry|readings?|values?|signals?|sensor(?:s)?)\b/i.test(
        normalized,
      ) ||
      (/\b(alarms?|warnings?|faults?|trips?)\b/i.test(normalized) &&
        asksForInventory);

    if (!mentionsTelemetryInventory || !asksForInventory) {
      return null;
    }

    const wantsSampleList = /\b(random|sample|some|few|selection)\b/i.test(
      normalized,
    );
    const wantsFullList =
      /\b(all|available|full|complete|entire|every)\b/i.test(normalized) &&
      !wantsSampleList;
    if (wantsFullList) {
      return { mode: 'full' };
    }

    const countMatch = normalized.match(/\b(\d{1,2})\b/);
    if (countMatch) {
      const parsed = Number.parseInt(countMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return { mode: 'sample', limit: Math.min(parsed, 25) };
      }
    }

    if (wantsSampleList) {
      return { mode: 'sample', limit: 10 };
    }

    return { mode: 'full' };
  }

  private getRequestedTelemetrySampleSize(
    query: string,
    resolvedSubjectQuery?: string,
  ): number | null {
    const request = this.parseTelemetryListRequest(query, resolvedSubjectQuery);
    return request?.mode === 'sample' ? (request.limit ?? 10) : null;
  }

  private buildTelemetryQuerySignals(
    query: string,
    resolvedSubjectQuery?: string,
  ): {
    normalizedQuery: string;
    tokens: string[];
    phrases: string[];
  } {
    const rawSearchSpace = `${query}\n${resolvedSubjectQuery ?? ''}`;
    const normalizedQuery = this.normalizeTelemetryText(rawSearchSpace);
    const explicitDirectionalTokens =
      this.extractExplicitTelemetryDirectionalTokens(rawSearchSpace);
    const stopWords = new Set([
      'all',
      'am',
      'and',
      'at',
      'average',
      'avg',
      'be',
      'been',
      'combined',
      'consumed',
      'consumption',
      'what',
      'which',
      'when',
      'where',
      'why',
      'how',
      'the',
      'a',
      'an',
      'is',
      'are',
      'do',
      'does',
      'did',
      'done',
      'display',
      'displayed',
      'displaying',
      'displays',
      'find',
      'get',
      'got',
      'has',
      'have',
      'had',
      'historical',
      'history',
      'i',
      'in',
      'increase',
      'into',
      'it',
      'its',
      'last',
      'list',
      'lookup',
      'many',
      'max',
      'maximum',
      'me',
      'mean',
      'min',
      'minimum',
      'my',
      'much',
      'of',
      'on',
      'onboard',
      'or',
      'our',
      'out',
      'overall',
      'output',
      'over',
      'past',
      'period',
      'previous',
      'vessel',
      'yacht',
      'show',
      'tell',
      'give',
      'return',
      'provide',
      'current',
      'status',
      'value',
      'reading',
      'please',
      'for',
      'to',
      'ship',
      'boat',
      'sea',
      'wolf',
      'x',
      'based',
      'any',
      'action',
      'actions',
      'according',
      'recommended',
      'recommendation',
      'calculate',
      'related',
      'latest',
      'metric',
      'metrics',
      'telemetry',
      'readings',
      'values',
      'sum',
      'total',
      'active',
      'connected',
      'day',
      'days',
      'enabled',
      'month',
      'months',
      'random',
      'remaining',
      'right',
      'now',
      'their',
      'with',
      'from',
      'left',
      'available',
      'up',
      'us',
      'using',
      'we',
      'week',
      'weeks',
      'were',
      'will',
      'would',
      'year',
      'years',
      'used',
      'your',
      'best',
      'match',
      'matches',
      'this',
      'that',
    ]);

    const baseTokens = [
      ...new Set(
        normalizedQuery
          .split(/\s+/)
          .map((token) => this.normalizeTelemetryToken(token.trim()))
          .filter(Boolean)
          .filter((token) => token.length >= 2)
          .filter((token) => !/^\d+$/.test(token))
          .filter((token) => !stopWords.has(token))
          .filter(
            (token) =>
              !this.isTelemetryDirectionalToken(token) ||
              explicitDirectionalTokens.has(token),
          ),
      ),
    ];

    const tokens = [
      ...new Set(
        baseTokens.flatMap((token) => this.expandTelemetryTokenVariants(token)),
      ),
    ];

    const phrases = [
      ...new Set(
        baseTokens.flatMap((_, index) => {
          const phrases: string[] = [];
          const pair = baseTokens.slice(index, index + 2);
          const triple = baseTokens.slice(index, index + 3);
          if (pair.length === 2) phrases.push(pair.join(' '));
          if (triple.length === 3) phrases.push(triple.join(' '));
          return phrases;
        }),
      ),
    ];

    return {
      normalizedQuery,
      tokens,
      phrases,
    };
  }

  private scoreTelemetryEntry(
    entry: ShipTelemetryEntry,
    querySignals: {
      normalizedQuery: string;
      tokens: string[];
      phrases: string[];
    },
  ): number {
    const haystack = this.buildTelemetryHaystack(entry);
    const query = querySignals.normalizedQuery;
    const normalizedField = this.normalizeTelemetryText(entry.field ?? '');
    const normalizedLabel = this.normalizeTelemetryText(entry.label ?? '');
    const normalizedMeasurement = this.normalizeTelemetryText(
      entry.measurement ?? '',
    );
    const normalizedDescription = this.normalizeTelemetryText(
      entry.description ?? '',
    );
    const queryKinds = this.extractTelemetryQueryMeasurementKinds(query);
    const entryKinds = this.extractTelemetryEntryMeasurementKinds(entry);
    const subjectTokens = this.getTelemetrySubjectTokens(querySignals.tokens);
    const matchedSubjectTokens = subjectTokens.filter((token) =>
      this.matchesTelemetrySubjectToken(haystack, token),
    );
    const matchedKinds = [...queryKinds].filter((kind) => entryKinds.has(kind));

    let score = 0;
    const exactCandidates = [
      entry.field,
      entry.label,
      entry.measurement && entry.field
        ? `${entry.measurement} ${entry.field}`
        : '',
      entry.description,
    ]
      .map((value) => this.normalizeTelemetryText(value ?? ''))
      .filter(Boolean);

    for (const candidate of exactCandidates) {
      if (query && candidate === query) score += 220;
      if (
        query &&
        candidate &&
        this.isStrongTelemetryCandidate(candidate) &&
        query.includes(candidate)
      ) {
        score += 140;
      }
      if (
        query &&
        candidate &&
        this.isStrongTelemetryCandidate(candidate) &&
        candidate.includes(query) &&
        query.length >= 4
      ) {
        score += 90;
      }
    }

    for (const phrase of querySignals.phrases) {
      if (phrase && haystack.includes(phrase)) {
        score += phrase.split(' ').length === 3 ? 30 : 18;
      }
      if (phrase && normalizedField.includes(phrase)) {
        score += phrase.split(' ').length === 3 ? 36 : 26;
      }
      if (phrase && normalizedLabel.includes(phrase)) {
        score += phrase.split(' ').length === 3 ? 32 : 22;
      }
      if (phrase && normalizedMeasurement.includes(phrase)) {
        score += phrase.split(' ').length === 3 ? 24 : 16;
      }
      if (phrase && normalizedDescription.includes(phrase)) {
        score += phrase.split(' ').length === 3 ? 18 : 12;
      }
    }

    for (const token of querySignals.tokens) {
      if (!haystack.includes(token)) continue;
      score += token.length >= 5 ? 8 : 5;
      if (normalizedField.includes(token)) {
        score += 8;
      }
      if (normalizedLabel.includes(token)) {
        score += 6;
      }
      if (normalizedMeasurement.includes(token)) {
        score += 5;
      }
      if (normalizedDescription.includes(token)) {
        score += 4;
      }
    }

    if (
      query &&
      /[a-z0-9]+(?:[_-][a-z0-9]+)+/i.test(query) &&
      entry.field &&
      normalizedField === query
    ) {
      score += 120;
    }

    if (entry.value !== null) {
      score += 2;
    }

    if (matchedKinds.length > 0) {
      score += matchedKinds.length * 24;
    }

    if (matchedSubjectTokens.length > 0) {
      score += matchedSubjectTokens.length * 6;
    }

    if (matchedKinds.length > 0 && matchedSubjectTokens.length > 0) {
      score += 38 + matchedSubjectTokens.length * 8;
    }

    return score;
  }

  private pickTelemetrySampleEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery: string | undefined,
    limit: number,
  ): {
    entries: ShipTelemetryEntry[];
    totalMatches: number;
  } {
    const cappedLimit = Math.max(1, Math.min(limit, entries.length));
    const seed = this.createTelemetrySampleSeed(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    const querySignals = this.buildTelemetryQuerySignals(
      query,
      resolvedSubjectQuery,
    );
    const scored = this.getScoredTelemetryEntries(entries, querySignals);
    const filteredMatches = this.filterScoredTelemetryEntries(scored).map(
      (candidate) => candidate.entry,
    );
    const samplePool = filteredMatches.length > 0 ? filteredMatches : entries;

    return {
      entries: [...samplePool]
        .sort((left, right) => {
          const leftScore = this.rankTelemetryEntryForSample(left, seed);
          const rightScore = this.rankTelemetryEntryForSample(right, seed);
          return rightScore - leftScore || left.key.localeCompare(right.key);
        })
        .slice(0, cappedLimit),
      totalMatches: samplePool.length,
    };
  }

  private getScoredTelemetryEntries(
    entries: ShipTelemetryEntry[],
    querySignals: {
      normalizedQuery: string;
      tokens: string[];
      phrases: string[];
    },
  ): Array<{ entry: ShipTelemetryEntry; score: number }> {
    return entries
      .map((entry) => ({
        entry,
        score: this.scoreTelemetryEntry(entry, querySignals),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.entry.key.localeCompare(right.entry.key),
      );
  }

  private filterTelemetryCandidatesByQuery(
    scored: Array<{ entry: ShipTelemetryEntry; score: number }>,
    querySignals: {
      normalizedQuery: string;
      tokens: string[];
      phrases: string[];
    },
  ): Array<{ entry: ShipTelemetryEntry; score: number }> {
    if (scored.length === 0) {
      return [];
    }

    const queryKinds = this.extractTelemetryQueryMeasurementKinds(
      querySignals.normalizedQuery,
    );
    const subjectTokens = this.getTelemetrySubjectTokens(querySignals.tokens);
    const isTelemetryInventoryQuery =
      /\b(metrics?|telemetry|readings?|values?|signals?|sensor(?:s)?)\b/i.test(
        querySignals.normalizedQuery,
      );
    const contextMatched = scored.filter((candidate) =>
      this.matchesTelemetrySpecificContext(
        candidate.entry,
        querySignals.normalizedQuery,
      ),
    );
    const searchSpace =
      contextMatched.length > 0
        ? contextMatched
        : this.hasStrictTelemetryContext(querySignals.normalizedQuery)
          ? []
          : scored;

    if (queryKinds.size === 0 || subjectTokens.length === 0) {
      if (
        queryKinds.size === 0 &&
        subjectTokens.length > 0 &&
        isTelemetryInventoryQuery
      ) {
        const withSubjectOnly = searchSpace.filter((candidate) =>
          this.matchesTelemetrySubject(candidate.entry, subjectTokens),
        );
        if (withSubjectOnly.length > 0) {
          return withSubjectOnly;
        }
      }

      if (contextMatched.length > 0) {
        return contextMatched;
      }
      return this.hasStrictTelemetryContext(querySignals.normalizedQuery)
        ? []
        : scored;
    }

    const withSubject = searchSpace.filter((candidate) =>
      this.matchesTelemetrySubject(candidate.entry, subjectTokens),
    );
    const withSubjectAndKind = withSubject.filter((candidate) =>
      this.matchesTelemetryKinds(candidate.entry, queryKinds),
    );

    if (withSubjectAndKind.length > 0) {
      const directlyAssociated = this.filterTelemetryCandidatesByDirectSubjectKindAssociation(
        withSubjectAndKind,
        querySignals,
      );
      if (directlyAssociated.length > 0) {
        return directlyAssociated;
      }

      return withSubjectAndKind;
    }

    if (withSubject.length > 0) {
      return withSubject;
    }

    const withKind = searchSpace.filter((candidate) =>
      this.matchesTelemetryKinds(candidate.entry, queryKinds),
    );
    return withKind.length > 0 ? withKind : searchSpace;
  }

  private filterScoredTelemetryEntries(
    scored: Array<{ entry: ShipTelemetryEntry; score: number }>,
  ): Array<{ entry: ShipTelemetryEntry; score: number }> {
    if (scored.length === 0) {
      return [];
    }

    const topScore = scored[0].score;
    const minimumScore =
      topScore >= 200 ? 60 : topScore >= 160 ? 40 : topScore >= 90 ? 24 : 14;
    const relativeMinimum =
      topScore >= 60 ? Math.ceil(topScore * 0.7) : minimumScore;
    const cutoff = Math.max(minimumScore, relativeMinimum);

    return scored.filter((candidate) => candidate.score >= cutoff);
  }

  private filterTelemetryCandidatesByDirectSubjectKindAssociation(
    candidates: Array<{ entry: ShipTelemetryEntry; score: number }>,
    querySignals: {
      normalizedQuery: string;
      tokens: string[];
      phrases: string[];
    },
  ): Array<{ entry: ShipTelemetryEntry; score: number }> {
    const queryKinds = [
      ...this.extractTelemetryQueryMeasurementKinds(querySignals.normalizedQuery),
    ];
    if (queryKinds.length !== 1) {
      return [];
    }

    const subjectTokens = this.getTelemetrySubjectTokens(querySignals.tokens);
    if (subjectTokens.length === 0) {
      return [];
    }

    return candidates.filter((candidate) =>
      subjectTokens.some((subjectToken) =>
        this.hasTelemetryDirectSubjectKindAssociation(
          candidate.entry,
          subjectToken,
          queryKinds[0],
        ),
      ),
    );
  }

  private hasTelemetryDirectSubjectKindAssociation(
    entry: ShipTelemetryEntry,
    subjectToken: string,
    kind: string,
  ): boolean {
    const candidateTexts = [
      entry.field ?? '',
      entry.label ?? '',
      entry.description ?? '',
    ]
      .map((value) => this.normalizeTelemetryText(value))
      .filter(Boolean);
    if (candidateTexts.length === 0) {
      return false;
    }

    const normalizedSubject = this.normalizeTelemetryToken(subjectToken);
    const kindTokens = this.getTelemetryKindAssociationTokens(kind);

    return candidateTexts.some((text) =>
      kindTokens.some((kindToken) =>
        this.hasTelemetryNearbyOrderedTokens(
          text,
          normalizedSubject,
          kindToken,
          1,
        ),
      ),
    );
  }

  private hasTelemetryNearbyOrderedTokens(
    text: string,
    firstToken: string,
    secondToken: string,
    maxIntermediateTokens: number,
  ): boolean {
    const tokens = this.normalizeTelemetryText(text)
      .split(/\s+/)
      .filter(Boolean);
    if (tokens.length === 0) {
      return false;
    }

    const firstVariants = new Set(
      this.expandTelemetryTokenVariants(this.normalizeTelemetryToken(firstToken)),
    );
    const secondVariants = new Set(
      this.expandTelemetryTokenVariants(
        this.normalizeTelemetryToken(secondToken),
      ),
    );

    for (let index = 0; index < tokens.length; index += 1) {
      if (!firstVariants.has(tokens[index])) {
        continue;
      }

      const maxIndex = Math.min(
        tokens.length - 1,
        index + maxIntermediateTokens + 1,
      );
      for (let nextIndex = index + 1; nextIndex <= maxIndex; nextIndex += 1) {
        if (secondVariants.has(tokens[nextIndex])) {
          return true;
        }
      }
    }

    return false;
  }

  private getTelemetryKindAssociationTokens(kind: string): string[] {
    switch (kind) {
      case 'current':
        return ['current'];
      case 'voltage':
        return ['voltage'];
      case 'speed':
        return ['speed', 'rpm'];
      case 'temperature':
        return ['temperature', 'temp'];
      case 'pressure':
        return ['pressure'];
      case 'load':
        return ['load'];
      case 'power':
        return ['power'];
      case 'energy':
        return ['energy'];
      case 'flow':
        return ['flow', 'rate'];
      case 'hours':
        return ['hours', 'hour', 'runtime', 'running'];
      case 'status':
        return ['status', 'state', 'alarm', 'warning', 'fault', 'trip'];
      case 'level':
        return ['level'];
      case 'location':
        return ['location', 'position', 'gps', 'latitude', 'longitude'];
      default:
        return [kind];
    }
  }

  private ensureBestTelemetryKindCoverage(
    selected: Array<{ entry: ShipTelemetryEntry; score: number }>,
    candidates: Array<{ entry: ShipTelemetryEntry; score: number }>,
    normalizedQuery: string,
  ): Array<{ entry: ShipTelemetryEntry; score: number }> {
    const queryKinds = [
      ...this.extractTelemetryQueryMeasurementKinds(normalizedQuery),
    ].filter((kind) => kind !== 'location');
    if (queryKinds.length <= 1) {
      return selected;
    }

    const byKey = new Map(
      selected.map((candidate) => [candidate.entry.key, candidate]),
    );
    const subjectTokens = this.getTelemetrySubjectTokens(
      this.buildTelemetryQuerySignals(normalizedQuery).tokens,
    );
    const subjectScopedCandidates =
      subjectTokens.length > 0
        ? candidates.filter(
            (candidate) =>
              this.matchesTelemetrySpecificContext(
                candidate.entry,
                normalizedQuery,
              ) && this.matchesTelemetrySubject(candidate.entry, subjectTokens),
          )
        : [];
    for (const kind of queryKinds) {
      const candidatePool =
        subjectScopedCandidates.some((candidate) =>
          this.extractTelemetryEntryMeasurementKinds(candidate.entry).has(kind),
        )
          ? subjectScopedCandidates
          : candidates;
      const bestForKind = candidatePool.find((candidate) =>
        this.extractTelemetryEntryMeasurementKinds(candidate.entry).has(kind),
      );
      if (bestForKind && !byKey.has(bestForKind.entry.key)) {
        byKey.set(bestForKind.entry.key, bestForKind);
      }
    }

    return [...byKey.values()].sort(
      (left, right) =>
        right.score - left.score ||
        left.entry.key.localeCompare(right.entry.key),
    );
  }

  private createTelemetrySampleSeed(value: string): number {
    let hash = 0;
    for (const char of value) {
      hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return hash || 1;
  }

  private rankTelemetryEntryForSample(
    entry: ShipTelemetryEntry,
    seed: number,
  ): number {
    const haystack = `${entry.key}|${entry.bucket ?? ''}|${entry.measurement ?? ''}|${entry.field ?? ''}`;
    let hash = seed;
    for (const char of haystack) {
      hash = (hash * 33 + char.charCodeAt(0)) >>> 0;
    }
    return hash;
  }

  private determineTelemetryMatchMode(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): 'exact' | 'direct' | 'related' {
    const normalizedQuery = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    const first = entries[0];
    if (!first) return 'related';

    const aggregateFluid = this.detectStoredFluidSubject(normalizedQuery);
    if (
      aggregateFluid &&
      this.isAggregateStoredFluidQuery(normalizedQuery, aggregateFluid) &&
      entries.length > 0 &&
      entries.every((entry) =>
        this.isDirectTankStorageEntry(entry, aggregateFluid),
      )
    ) {
      return 'direct';
    }

    if (this.isTelemetryLocationQuery(normalizedQuery)) {
      const coordinateKinds = new Set(
        entries.flatMap((entry) => [
          ...this.getTelemetryCoordinateKinds(entry),
        ]),
      );
      if (coordinateKinds.size > 0) {
        return 'direct';
      }
    }

    const exactCandidates = [
      first.field,
      first.label,
      first.measurement && first.field
        ? `${first.measurement} ${first.field}`
        : '',
      first.key,
    ]
      .map((value) => this.normalizeTelemetryText(value ?? ''))
      .filter(Boolean);

    if (exactCandidates.some((candidate) => candidate === normalizedQuery)) {
      return 'exact';
    }

    if (
      exactCandidates.some(
        (candidate) =>
          Boolean(candidate) &&
          this.isStrongTelemetryCandidate(candidate) &&
          normalizedQuery.includes(candidate),
      )
    ) {
      return 'exact';
    }

    const queryKinds =
      this.extractTelemetryQueryMeasurementKinds(normalizedQuery);
    const subjectTokens = this.getTelemetrySubjectTokens(
      this.buildTelemetryQuerySignals(query, resolvedSubjectQuery).tokens,
    );
    if (queryKinds.size === 0) {
      return 'direct';
    }

    const hasDirectMeasurementKind = entries.some((entry) => {
      const entryKinds = this.extractTelemetryEntryMeasurementKinds(entry);
      return [...queryKinds].some((kind) => entryKinds.has(kind));
    });

    if (!hasDirectMeasurementKind) {
      return 'related';
    }

    if (subjectTokens.length === 0) {
      return 'direct';
    }

    const hasDirectSubjectAndKind = entries.some((entry) => {
      const haystack = this.buildTelemetryHaystack(entry);
      const entryKinds = this.extractTelemetryEntryMeasurementKinds(entry);
      const matchesSubject = subjectTokens.some((token) =>
        this.matchesTelemetrySubjectToken(haystack, token),
      );
      return (
        matchesSubject && [...queryKinds].some((kind) => entryKinds.has(kind))
      );
    });

    return hasDirectSubjectAndKind ? 'direct' : 'related';
  }

  private buildTelemetryClarification(
    matchMode: 'none' | 'sample' | 'exact' | 'direct' | 'related',
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
    forcedClarificationReason?: 'ambiguous_tank_reading' | null,
  ): ShipTelemetryContext['clarification'] {
    if (matchMode !== 'related' && !forcedClarificationReason) {
      return null;
    }

    if (!this.shouldOfferTelemetryClarification(query, resolvedSubjectQuery)) {
      return null;
    }

    const actions = this.buildTelemetryClarificationActions(entries, query);
    if (actions.length === 0) {
      return null;
    }

    return {
      question:
        forcedClarificationReason === 'ambiguous_tank_reading'
          ? 'I found multiple current tank readings that could match this question. Which tank do you want to inspect?'
          : "I couldn't find a direct telemetry metric that exactly measures the requested reading, but I did find related metrics for the same topic. Which one do you want to inspect?",
      pendingQuery: this.buildTelemetryClarificationPendingQuery(query),
      actions,
    };
  }

  private getTelemetryForcedClarificationReason(
    matchMode: 'exact' | 'direct' | 'related',
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): 'ambiguous_tank_reading' | null {
    if (matchMode !== 'direct') {
      return null;
    }

    if (!this.shouldOfferTelemetryClarification(query, resolvedSubjectQuery)) {
      return null;
    }

    const normalizedQuery = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );

    const fluid = this.detectStoredFluidSubject(normalizedQuery);
    if (fluid && this.isAggregateStoredFluidQuery(normalizedQuery, fluid)) {
      return null;
    }

    return this.shouldForceTankTelemetryClarification(entries, normalizedQuery)
      ? 'ambiguous_tank_reading'
      : null;
  }

  private shouldOfferTelemetryClarification(
    query: string,
    resolvedSubjectQuery?: string,
  ): boolean {
    if (this.parseTelemetryListRequest(query, resolvedSubjectQuery) != null) {
      return false;
    }

    const searchSpace = `${query}\n${resolvedSubjectQuery ?? ''}`;
    if (
      /\b(best\s+match|closest|matches?|related\s+metric|related\s+telemetry)\b/i.test(
        searchSpace,
      )
    ) {
      return false;
    }

    if (
      /\b(parts?|spares?|part\s*numbers?|consumables?|filters?)\b/i.test(
        searchSpace,
      )
    ) {
      return false;
    }

    const asksForActionFromReading =
      /\b(based\s+on|depending\s+on|according\s+to)\b[\s\S]{0,120}\b(current|reading|value|level|temperature|temp|pressure|voltage|load|rpm|speed|flow|rate|status)\b/i.test(
        searchSpace,
      ) ||
      (/\b(what\s+should\s+i\s+do|what\s+do\s+i\s+do|is\s+any\s+action\s+recommended|any\s+action\s+recommended|next\s+step|next\s+steps)\b/i.test(
        searchSpace,
      ) &&
        /\b(current|reading|value|level|temperature|temp|pressure|voltage|load|rpm|speed|flow|rate|status)\b/i.test(
          searchSpace,
        ));

    const isProcedureLike =
      /\b(how\s+do\s+i|how\s+to|replace|change|install|remove|maintenance|service|procedure|steps?|manual|documentation)\b/i.test(
        searchSpace,
      );
    if (isProcedureLike && !asksForActionFromReading) {
      return false;
    }

    const asksForReading =
      /\b(current|currently|status|reading|value|level|temperature|temp|pressure|voltage|load|rpm|speed|flow|rate|remaining|left|available|onboard)\b/i.test(
        searchSpace,
      ) ||
      /\bhow\s+much\b|\bhow\s+many\b/i.test(searchSpace) ||
      /\bfrom\s+telemetry\b|\bfrom\s+metrics\b/i.test(searchSpace);

    const mentionsTelemetrySignal =
      /\b(oil|fuel|coolant|fresh\s*water|seawater|water|tank|battery|depth|rudder|trim|temperature|temp|pressure|voltage|current|load|rpm|speed|level|flow|rate|generator|genset|engine|pump|compressor|sensor|meter)\b/i.test(
        searchSpace,
      );

    return (
      mentionsTelemetrySignal && (asksForReading || asksForActionFromReading)
    );
  }

  private buildTelemetryClarificationActions(
    entries: ShipTelemetryEntry[],
    query: string,
  ): NonNullable<ShipTelemetryContext['clarification']>['actions'] {
    const selected: NonNullable<
      ShipTelemetryContext['clarification']
    >['actions'] = [];
    const seen = new Set<string>();

    for (const entry of entries) {
      const label = this.buildTelemetrySuggestionLabel(entry);
      const normalizedLabel = this.normalizeTelemetryText(label);
      if (!label || seen.has(normalizedLabel)) {
        continue;
      }

      seen.add(normalizedLabel);
      selected.push({
        label,
        message: this.buildTelemetryClarificationActionMessage(query, entry),
        kind: 'suggestion',
      });

      if (selected.length >= 4) {
        break;
      }
    }

    if (selected.length <= 1) {
      return selected;
    }

    return [
      ...selected,
      {
        label: 'All related',
        message: this.buildTelemetryClarificationAllMessage(selected),
        kind: 'all',
      },
    ];
  }

  private buildTelemetrySuggestionLabel(entry: ShipTelemetryEntry): string {
    if (entry.measurement && entry.field) {
      return `${entry.measurement}.${entry.field}`;
    }

    return entry.label || entry.key;
  }

  private buildTelemetryClarificationActionMessage(
    query: string,
    entry: ShipTelemetryEntry,
  ): string {
    const label = this.buildTelemetrySuggestionLabel(entry);
    if (this.isTelemetryActionRecommendationQuery(query)) {
      return `Based on the current value of ${label}, is any action recommended?`;
    }

    return `What is the current value of ${label}?`;
  }

  private buildTelemetryClarificationAllMessage(
    actions: Array<{ label: string }>,
  ): string {
    const labels = actions
      .map((action) => action.label.trim())
      .filter(Boolean)
      .slice(0, 4);

    return `Show the current values of these related metrics: ${labels.join('; ')}.`;
  }

  private buildTelemetryClarificationPendingQuery(query: string): string {
    if (this.isTelemetryActionRecommendationQuery(query)) {
      return 'Based on the current value of';
    }

    return 'What is the current value of';
  }

  private isTelemetryActionRecommendationQuery(query: string): boolean {
    return (
      /\b(based\s+on|depending\s+on|according\s+to)\b[\s\S]{0,120}\b(current|reading|value|level|temperature|temp|pressure|voltage|load|rpm|speed|flow|rate|status)\b/i.test(
        query,
      ) ||
      (/\b(what\s+should\s+i\s+do|what\s+do\s+i\s+do|is\s+any\s+action\s+recommended|any\s+action\s+recommended|next\s+step|next\s+steps)\b/i.test(
        query,
      ) &&
        /\b(current|reading|value|level|temperature|temp|pressure|voltage|load|rpm|speed|flow|rate|status)\b/i.test(
          query,
        ))
    );
  }

  private extractTelemetryMeasurementKinds(value: string): Set<string> {
    const kinds = new Set<string>();
    const normalized = this.normalizeTelemetryText(value);
    const inventoryContextBlocked =
      /\b(used|consumed|consumption|usage|rate|flow|pressure|temp(?:erature)?|voltage|power|energy|frequency|status|state|alarm|warning|fault|trip)\b/i.test(
        normalized,
      );
    const hasTankOrFluidContext =
      /\btank\b/i.test(normalized) ||
      /\b(fuel|oil|coolant|water|def|urea|adblue)\b/i.test(normalized);
    const hasInventoryContext =
      hasTankOrFluidContext ||
      /\b(volume|quantity|contents?|remaining|available|onboard|capacity)\b/i.test(
        normalized,
      ) ||
      /\b(l|lt|ltr|liters?|litres?|percent|percentage|%|gal|gallons?|m3|m 3)\b/i.test(
        normalized,
      );
    const mentionsNonInventoryLevel =
      /\b(voltage|current|power|signal|frequency|sound|audio|noise)\s+levels?\b/i.test(
        normalized,
      ) ||
      /\blevels?\s+of\s+(voltage|current|power|signal|frequency|sound|audio|noise)\b/i.test(
        normalized,
      );
    const checks: Array<[RegExp, string]> = [
      [/\b(temp(?:eratures?)?|temps?)\b/i, 'temperature'],
      [/\b(pressures?)\b/i, 'pressure'],
      [/\b(voltages?|volts?)\b/i, 'voltage'],
      [/\b(currents?|amperage|amps?)\b/i, 'current'],
      [/\b(loads?)\b/i, 'load'],
      [/\b(power|powers?|watts?|kilowatts?|megawatts?|kw|mw)\b/i, 'power'],
      [
        /\b(energies?|watt\s*hours?|kilowatt\s*hours?|megawatt\s*hours?|wh|kwh|mwh)\b/i,
        'energy',
      ],
      [/\b(rpms?|speeds?)\b/i, 'speed'],
      [/\b(flows?|rates?)\b/i, 'flow'],
      [/\b(runtime|runtimes|running|hours?|hour\s*meter)\b/i, 'hours'],
      [
        /\b(status(?:es)?|state(?:s)?|alarms?|warnings?|faults?|trips?)\b/i,
        'status',
      ],
    ];

    for (const [pattern, label] of checks) {
      if (pattern.test(value)) {
        kinds.add(label);
      }
    }

    if (
      /\b(latitude|longitude|coordinates?|gps|location|lat|lon)\b/i.test(
        normalized,
      ) ||
      (/\bposition\b/i.test(normalized) &&
        this.hasTelemetryNavigationPositionContext(normalized))
    ) {
      kinds.add('location');
    }

    if (
      /\b(levels?)\b/i.test(normalized) &&
      (!mentionsNonInventoryLevel || hasInventoryContext) &&
      !inventoryContextBlocked
    ) {
      kinds.add('level');
    }

    const asksForStoredQuantity =
      /\b(how much|how many|onboard|remaining|left|available)\b/i.test(
        normalized,
      ) &&
      /\b(fuel|oil|coolant|water|tank|def|urea)\b/i.test(normalized) &&
      !/\b(used|consumed|consumption|rate|flow)\b/i.test(normalized);
    if (asksForStoredQuantity) {
      kinds.add('level');
    }

    if (
      /\b(volume|quantity|contents?)\b/i.test(normalized) &&
      !inventoryContextBlocked
    ) {
      kinds.add('level');
    }

    const looksLikeTankQuantity =
      /\btank\b/i.test(normalized) &&
      /\b(fuel|oil|coolant|water|def|urea)\b/i.test(normalized) &&
      (/\b(l|lt|ltr|liters?|litres?|gal|gallons?|m3|m 3)\b/i.test(normalized) ||
        /\b(volume|quantity|contents?|remaining|available|onboard)\b/i.test(
          normalized,
        )) &&
      !/\b(used|consumed|consumption|rate|flow|pressure|temp|temperature)\b/i.test(
        normalized,
      );
    if (looksLikeTankQuantity) {
      kinds.add('level');
    }

    const hasQuantityUnit =
      /\b(l|lt|ltr|liters?|litres?|percent|percentage|%|gal|gallons?|m3|m 3)\b/i.test(
        normalized,
      ) && !inventoryContextBlocked;
    if (hasQuantityUnit) {
      kinds.add('level');
    }

    return kinds;
  }

  private extractTelemetryQueryMeasurementKinds(value: string): Set<string> {
    const kinds = this.extractTelemetryMeasurementKinds(value);
    const normalized = this.normalizeTelemetryText(value);
    const fluid = this.detectStoredFluidSubject(normalized);
    const treatsCurrentAsLiveQualifier =
      kinds.has('current') &&
      !this.isElectricalCurrentQuery(normalized) &&
      ([...kinds].some((kind) => kind !== 'current') ||
        /\bcurrent\b\s+(value|values|reading|readings|status|state|metric|metrics|telemetry|signal|signals|level|levels|temperature|temperatures|pressure|pressures|voltage|voltages|power|powers|flow|flows|rate|rates|hours?|runtime)\b/i.test(
          normalized,
        ) ||
        /\b(now|right now|latest)\b/i.test(normalized) ||
        Boolean(fluid && /\btanks?\b/i.test(normalized)));

    if (treatsCurrentAsLiveQualifier) {
      kinds.delete('current');
    }

    if (
      /\b(active|inactive|enabled|disabled|running|stopped|open|closed|online|offline)\b/i.test(
        normalized,
      ) &&
      !/\b(power|energy|load|current|voltage|temperature|pressure|flow|rate|speed|rpm|hours?|runtime)\b/i.test(
        normalized,
      )
    ) {
      kinds.add('status');
    }

    return kinds;
  }

  private buildTelemetryHaystack(entry: ShipTelemetryEntry): string {
    return this.normalizeTelemetryText(
      [
        entry.key,
        entry.label,
        entry.bucket,
        entry.measurement,
        entry.field,
        entry.description,
        entry.unit,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  private buildTelemetryIdentityHaystack(entry: ShipTelemetryEntry): string {
    return this.normalizeTelemetryText(
      [
        entry.key,
        entry.label,
        entry.bucket,
        entry.measurement,
        entry.field,
        entry.unit,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  private extractTelemetryEntryMeasurementKinds(
    entry: ShipTelemetryEntry,
  ): Set<string> {
    const kinds = this.extractTelemetryMeasurementKinds(
      this.buildTelemetryIdentityHaystack(entry),
    );

    if (
      !kinds.has('level') &&
      (['fuel', 'oil', 'water', 'coolant', 'def'] as const).some((fluid) =>
        this.isDedicatedTankStorageField(entry, { fluid }),
      )
    ) {
      kinds.add('level');
    }

    return kinds;
  }

  private matchesTelemetrySubject(
    entry: ShipTelemetryEntry,
    subjectTokens: string[],
  ): boolean {
    if (subjectTokens.length === 0) {
      return true;
    }

    const haystack = this.buildTelemetryHaystack(entry);
    const matchedCount = subjectTokens.filter((token) =>
      this.matchesTelemetrySubjectToken(haystack, token),
    ).length;
    const minimumMatches = Math.min(subjectTokens.length, 2);
    return matchedCount >= minimumMatches;
  }

  private matchesTelemetryKinds(
    entry: ShipTelemetryEntry,
    queryKinds: Set<string>,
  ): boolean {
    if (queryKinds.size === 0) {
      return true;
    }

    const entryKinds = this.extractTelemetryEntryMeasurementKinds(entry);
    return [...queryKinds].some((kind) => entryKinds.has(kind));
  }

  private normalizeTelemetryText(value: string): string {
    return value
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_./:-]+/g, ' ')
      .replace(/[^a-zA-Z0-9\s]+/g, ' ')
      .replace(/\btemps?\b/g, ' temperature ')
      .replace(/\bvolt(s)?\b/g, ' voltage ')
      .replace(/\bstbd\b/g, ' starboard ')
      .replace(/\bsb\b/g, ' starboard ')
      .replace(/\bps\b/g, ' port ')
      .replace(/\bgenerator\s+set\b/g, ' genset ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private isTelemetryDirectionalToken(token: string): boolean {
    return token === 'port' || token === 'starboard';
  }

  private extractExplicitTelemetryDirectionalTokens(
    query: string,
  ): Set<string> {
    const normalized = query.toLowerCase();
    const tokens = new Set<string>();
    const directionalNouns =
      '(side|engine|generator|genset|pump|tank|battery|charger|motor|gearbox|thruster|rudder|cabin|room|propeller)';

    if (/\b(port|ps)\b/i.test(normalized)) {
      tokens.add('port');
    }

    if (/\b(starboard|stbd|sb)\b/i.test(normalized)) {
      tokens.add('starboard');
    }

    if (
      new RegExp(`\\bleft\\b\\s+${directionalNouns}\\b`, 'i').test(normalized)
    ) {
      tokens.add('port');
    }

    if (
      new RegExp(`\\bright\\b\\s+${directionalNouns}\\b`, 'i').test(normalized)
    ) {
      tokens.add('starboard');
    }

    return tokens;
  }

  private getTelemetrySubjectTokens(tokens: string[]): string[] {
    return [
      ...new Set(
        tokens
          .filter((token) => !this.isTelemetryKindToken(token))
          .map((token) => this.canonicalizeTelemetrySubjectToken(token)),
      ),
    ];
  }

  private isTelemetryKindToken(token: string): boolean {
    return new Set([
      'amp',
      'amps',
      'amperage',
      'alarm',
      'warning',
      'fault',
      'trip',
      'current',
      'energy',
      'flow',
      'hour',
      'hours',
      'lat',
      'latitude',
      'level',
      'location',
      'load',
      'lon',
      'longitude',
      'pressure',
      'power',
      'position',
      'rate',
      'reading',
      'rpm',
      'runtime',
      'speed',
      'state',
      'status',
      'temp',
      'temperature',
      'value',
      'voltage',
      'coordinate',
      'coordinates',
      'gps',
    ]).has(token);
  }

  private isStrongTelemetryCandidate(candidate: string): boolean {
    const normalized = this.normalizeTelemetryText(candidate);
    if (!normalized) return false;

    const terms = normalized.split(/\s+/).filter(Boolean);
    if (terms.length >= 2) return true;

    const [term] = terms;
    if (!term) return false;

    if (term.length >= 8) return true;
    if (term.length <= 3) return false;

    return !new Set([
      'all',
      'any',
      'lat',
      'lon',
      'rate',
      'state',
      'status',
      'value',
      'active',
    ]).has(term);
  }

  private normalizeTelemetryToken(token: string): string {
    if (!token) return '';

    const normalized = token.toLowerCase();
    const aliases: Record<string, string> = {
      batteries: 'battery',
      generators: 'generator',
      gensets: 'genset',
      right: 'starboard',
      left: 'port',
      stbd: 'starboard',
      sb: 'starboard',
      ps: 'port',
      alarms: 'alarm',
      warnings: 'warning',
      faults: 'fault',
      trips: 'trip',
      status: 'status',
      statuses: 'status',
      states: 'state',
      volts: 'voltage',
      volt: 'voltage',
      voltages: 'voltage',
      pressures: 'pressure',
      currents: 'current',
      powers: 'power',
      energies: 'energy',
      loads: 'load',
      flows: 'flow',
      rates: 'rate',
      temps: 'temperature',
      temp: 'temperature',
      readings: 'reading',
      metrics: 'metric',
      values: 'value',
      ships: 'ship',
    };

    if (aliases[normalized]) {
      return aliases[normalized];
    }

    if (normalized.endsWith('ies') && normalized.length > 4) {
      return `${normalized.slice(0, -3)}y`;
    }

    if (
      normalized.endsWith('s') &&
      normalized.length > 4 &&
      !normalized.endsWith('ss')
    ) {
      return normalized.slice(0, -1);
    }

    return normalized;
  }

  private expandTelemetryTokenVariants(token: string): string[] {
    const variants = new Set([token]);
    const aliasGroups = [
      ['generator', 'genset'],
      ['port', 'ps', 'left'],
      ['starboard', 'sb', 'stbd', 'right'],
      ['temperature', 'temp'],
      ['latitude', 'lat'],
      ['longitude', 'lon'],
      ['location', 'position', 'coordinates', 'coordinate', 'gps'],
    ];

    for (const group of aliasGroups) {
      if (group.includes(token)) {
        group.forEach((variant) => variants.add(variant));
      }
    }

    return [...variants];
  }

  private canonicalizeTelemetrySubjectToken(token: string): string {
    switch (token) {
      case 'genset':
        return 'generator';
      case 'ps':
      case 'left':
        return 'port';
      case 'sb':
      case 'stbd':
      case 'right':
        return 'starboard';
      default:
        return token;
    }
  }

  private matchesTelemetrySubjectToken(
    haystack: string,
    token: string,
  ): boolean {
    return this.expandTelemetryTokenVariants(token).some((variant) =>
      haystack.includes(variant),
    );
  }

  private hasStrictTelemetryContext(normalizedQuery: string): boolean {
    return /\b(engine room|generator|genset|engine|gearbox|pump|coolant|oil|fuel|battery)\b/i.test(
      normalizedQuery,
    );
  }

  private matchesTelemetrySpecificContext(
    entry: ShipTelemetryEntry,
    normalizedQuery: string,
  ): boolean {
    const haystack = this.buildTelemetryHaystack(entry);
    const mentionsPort = /\bport\b/i.test(normalizedQuery);
    const mentionsStarboard = /\bstarboard\b/i.test(normalizedQuery);
    const mentionsEngineRoom = /\bengine room\b/i.test(normalizedQuery);
    const mentionsGenerator = /\b(generator|genset)\b/i.test(normalizedQuery);
    const mentionsMainEngine =
      /\bengine\b/i.test(normalizedQuery) &&
      !mentionsEngineRoom &&
      !mentionsGenerator;

    if (mentionsPort && !mentionsStarboard) {
      if (!/\bport\b/i.test(haystack) || /\bstarboard\b/i.test(haystack)) {
        return false;
      }
    }

    if (mentionsStarboard && !mentionsPort) {
      if (!/\bstarboard\b/i.test(haystack) || /\bport\b/i.test(haystack)) {
        return false;
      }
    }

    if (mentionsEngineRoom && !/\bengine room\b/i.test(haystack)) {
      return false;
    }

    if (mentionsGenerator && !/\b(generator|genset)\b/i.test(haystack)) {
      return false;
    }

    if (
      mentionsMainEngine &&
      /\b(generator|genset|engine room)\b/i.test(haystack)
    ) {
      return false;
    }

    const requiredTerms = ['coolant', 'oil', 'fuel', 'battery', 'depth'];
    for (const term of requiredTerms) {
      if (
        new RegExp(`\\b${term}\\b`, 'i').test(normalizedQuery) &&
        !new RegExp(`\\b${term}\\b`, 'i').test(haystack)
      ) {
        return false;
      }
    }

    const requiredWaterQualifiers =
      this.detectStoredFluidSubject(normalizedQuery)?.waterQualifiers ?? [];
    if (
      requiredWaterQualifiers.length > 0 &&
      !requiredWaterQualifiers.some((qualifier) =>
        this.matchesWaterQualifier(haystack, qualifier),
      )
    ) {
      return false;
    }

    return true;
  }

  private containsLoosely(left: string, right: string): boolean {
    return this.normalizeTelemetryText(left).includes(
      this.normalizeTelemetryText(right),
    );
  }

  private detectWaterQualifiers(
    normalizedQuery: string,
  ): StoredFluidSubject['waterQualifiers'] {
    const qualifiers = new Set<
      NonNullable<StoredFluidSubject['waterQualifiers']>[number]
    >();

    if (/\bfresh\s*water\b/i.test(normalizedQuery)) {
      qualifiers.add('fresh');
    }
    if (/\bsea\s*water\b|\bseawater\b/i.test(normalizedQuery)) {
      qualifiers.add('sea');
    }
    if (
      /\bblack(?:\s+and\s+grey|\s*&\s*grey)?\s+water\b/i.test(normalizedQuery)
    ) {
      qualifiers.add('black');
      if (/\bgrey\b|\bgray\b/i.test(normalizedQuery)) {
        qualifiers.add('grey');
      }
    } else if (/\bblack\s+water\b/i.test(normalizedQuery)) {
      qualifiers.add('black');
    }
    if (/\bgrey\s+water\b|\bgray\s+water\b/i.test(normalizedQuery)) {
      qualifiers.add('grey');
    }
    if (
      /\bbilge\s+water\b|\bbilge\b[\s\S]{0,12}\btank\b/i.test(normalizedQuery)
    ) {
      qualifiers.add('bilge');
    }

    return qualifiers.size > 0 ? [...qualifiers] : undefined;
  }

  private matchesWaterQualifier(
    haystack: string,
    qualifier: NonNullable<StoredFluidSubject['waterQualifiers']>[number],
  ): boolean {
    switch (qualifier) {
      case 'fresh':
        return /\bfresh\s*water\b/i.test(haystack);
      case 'sea':
        return /\bsea\s*water\b|\bseawater\b/i.test(haystack);
      case 'black':
        return /\bblack\b[\s\S]{0,12}\bwater\b/i.test(haystack);
      case 'grey':
        return /\b(grey|gray)\b[\s\S]{0,12}\bwater\b/i.test(haystack);
      case 'bilge':
        return /\bbilge\b[\s\S]{0,12}\bwater\b|\bbilge\b[\s\S]{0,12}\btank\b/i.test(
          haystack,
        );
      default:
        return false;
    }
  }

  private matchesStoredFluidSubject(
    haystack: string,
    subject: StoredFluidSubject,
  ): boolean {
    if (subject.fluid === 'water') {
      if (!/\bwater\b/i.test(haystack)) {
        return false;
      }

      if (!subject.waterQualifiers?.length) {
        return true;
      }

      return subject.waterQualifiers.some((qualifier) =>
        this.matchesWaterQualifier(haystack, qualifier),
      );
    }

    if (subject.fluid === 'def') {
      return /\b(def|urea)\b/i.test(haystack);
    }

    return new RegExp(`\\b${subject.fluid}\\b`, 'i').test(haystack);
  }

  private entryMatchesStoredFluidSubject(
    entry: ShipTelemetryEntry,
    subject: StoredFluidSubject,
  ): boolean {
    return this.matchesStoredFluidSubject(
      this.buildTelemetryHaystack(entry),
      subject,
    );
  }

  private detectStoredFluidSubject(
    normalizedQuery: string,
  ): StoredFluidSubject | null {
    if (/\bfuel\b/i.test(normalizedQuery)) return { fluid: 'fuel' };
    if (/\boil\b/i.test(normalizedQuery)) return { fluid: 'oil' };
    if (/\bcoolant\b/i.test(normalizedQuery)) return { fluid: 'coolant' };
    if (/\b(def|urea)\b/i.test(normalizedQuery)) return { fluid: 'def' };
    if (
      /\b(water|fresh water|seawater|sea water|black water|grey water|gray water|bilge water)\b/i.test(
        normalizedQuery,
      )
    ) {
      const waterQualifiers = this.detectWaterQualifiers(normalizedQuery);
      return (waterQualifiers?.length ?? 0) > 0
        ? { fluid: 'water', waterQualifiers }
        : { fluid: 'water' };
    }
    return null;
  }

  private describeStoredFluidSubject(subject: StoredFluidSubject): string {
    if (subject.fluid !== 'water') {
      return subject.fluid === 'def' ? 'DEF' : subject.fluid;
    }

    const qualifiers = subject.waterQualifiers ?? [];
    if (qualifiers.includes('fresh')) return 'fresh water';
    if (qualifiers.includes('sea')) return 'sea water';
    if (qualifiers.includes('black')) return 'black water';
    if (qualifiers.includes('grey')) return 'grey water';
    if (qualifiers.includes('bilge')) return 'bilge water';
    return 'water';
  }

  private isImplicitDailyStoredFluidUsageQuery(
    normalizedQuery: string,
  ): boolean {
    const subject = this.detectStoredFluidSubject(normalizedQuery);
    if (!subject) {
      return false;
    }

    return (
      /\b(daily|per\s+day|per-day)\b/i.test(normalizedQuery) &&
      !/\b(current|currently|now|right now|latest)\b/i.test(normalizedQuery) &&
      this.isHistoricalStoredFluidUsageQuery(normalizedQuery, subject)
    );
  }

  private isHistoricalStoredFluidUsageQuery(
    normalizedQuery: string,
    subject: StoredFluidSubject,
  ): boolean {
    const hasUsageIntent =
      /\b(used|usage|consumed|consumption|difference|delta|change|changed|trend|trending|history|historical|daily|per\s+day|per-day)\b/i.test(
        normalizedQuery,
      );
    if (!hasUsageIntent) {
      return false;
    }

    if (
      /\b(rate|flow|pressure|temp(?:erature)?|voltage|power|energy|frequency)\b/i.test(
        normalizedQuery,
      )
    ) {
      return false;
    }

    const hasInventoryAnchor =
      /\b(tank|tanks|level|levels|onboard|remaining|left|available|storage)\b/i.test(
        normalizedQuery,
      );

    return subject.fluid === 'fuel' ? hasInventoryAnchor : true;
  }

  private isAggregateStoredFluidQuery(
    normalizedQuery: string,
    subject: StoredFluidSubject,
  ): boolean {
    const asksForQuantity =
      /\b(how much|how many|total|sum|overall|combined|together|calculate)\b/i.test(
        normalizedQuery,
      ) || /\b(onboard|remaining|left|available)\b/i.test(normalizedQuery);
    if (!asksForQuantity) {
      return false;
    }

    const mentionsTankContext =
      /\b(tank|tanks)\b/i.test(normalizedQuery) ||
      (subject.fluid === 'fuel' && /\bonboard\b/i.test(normalizedQuery));

    return mentionsTankContext;
  }

  private isDirectStoredFluidInventoryQuery(
    normalizedQuery: string,
    subject: StoredFluidSubject,
  ): boolean {
    const fluidPattern =
      subject.fluid === 'water'
        ? /\bwater\b/i
        : subject.fluid === 'def'
          ? /\b(def|urea)\b/i
          : new RegExp(`\\b${subject.fluid}\\b`, 'i');

    if (!fluidPattern.test(normalizedQuery)) {
      return false;
    }

    if (
      /\b(used|consumed|consumption|usage|burn(?:ed|t|ing)?|spent|rate|flow|pressure|temp(?:erature)?|voltage|power|energy|frequency|status|state|alarm|warning|fault|trip)\b/i.test(
        normalizedQuery,
      )
    ) {
      return false;
    }

    const queryKinds =
      this.extractTelemetryQueryMeasurementKinds(normalizedQuery);
    const hasTankContext = /\b(tanks?|storage)\b/i.test(normalizedQuery);
    const hasInventoryIntent =
      /\b(level|levels|quantity|volume|contents?|inventory|remaining|left|available|onboard|amount)\b/i.test(
        normalizedQuery,
      );
    const hasLookupStyle =
      /\b(what|show|list|display|give|tell|provide)\b/i.test(normalizedQuery);
    const hasOnlyLiveQualifier =
      queryKinds.size === 0 &&
      /\b(current|now|right now|latest)\b/i.test(normalizedQuery);
    const hasSpecificTankReference =
      this.hasSpecificTankReference(normalizedQuery);

    return (
      !hasSpecificTankReference &&
      (hasInventoryIntent ||
        (hasTankContext && (hasLookupStyle || hasOnlyLiveQualifier)))
    );
  }

  private isImplicitHistoricalFuelInventoryQuery(
    normalizedQuery: string,
  ): boolean {
    return (
      /\bfuel\b/i.test(normalizedQuery) &&
      /\b(how much|how many|total|sum|overall|combined|together|left|remaining|available|onboard)\b/i.test(
        normalizedQuery,
      ) &&
      !/\b(used|consumed|consumption|usage|rate|flow|pressure|burn(?:ed|t|ing)?|spent|generator|genset)\b/i.test(
        normalizedQuery,
      )
    );
  }

  private isImplicitHistoricalStoredFluidInventoryQuery(
    normalizedQuery: string,
    subject: StoredFluidSubject,
  ): boolean {
    if (subject.fluid === 'fuel') {
      return this.isImplicitHistoricalFuelInventoryQuery(normalizedQuery);
    }

    return (
      this.matchesStoredFluidSubject(normalizedQuery, subject) &&
      /\b(how much|how many|total|sum|overall|combined|together|left|remaining|available|onboard)\b/i.test(
        normalizedQuery,
      ) &&
      !/\b(used|consumed|consumption|usage|rate|flow|pressure|burn(?:ed|t|ing)?|spent|generator|genset)\b/i.test(
        normalizedQuery,
      )
    );
  }

  private shouldUseHistoricalTankStorageAnalysis(
    request: ParsedHistoricalTelemetryRequest,
    normalizedQuery: string,
    subject: StoredFluidSubject,
  ): boolean {
    if (
      this.isAggregateStoredFluidQuery(normalizedQuery, subject) ||
      this.isImplicitHistoricalStoredFluidInventoryQuery(
        normalizedQuery,
        subject,
      )
    ) {
      return true;
    }

    return (
      (request.operation === 'delta' || request.operation === 'trend') &&
      this.isHistoricalStoredFluidUsageQuery(normalizedQuery, subject)
    );
  }

  private findHistoricalStoredFluidTankEntries(
    entries: ShipTelemetryEntry[],
    subject: StoredFluidSubject,
  ): ShipTelemetryEntry[] {
    return entries
      .filter((entry) =>
        this.isHistoricalAggregateTankStorageEntry(entry, subject),
      )
      .sort((left, right) => {
        const tankRank =
          this.getTelemetryTankOrder(left) - this.getTelemetryTankOrder(right);
        return tankRank || left.key.localeCompare(right.key);
      })
      .slice(0, 16);
  }

  private isDirectTankStorageEntry(
    entry: ShipTelemetryEntry,
    subject: StoredFluidSubject,
  ): boolean {
    const haystack = this.buildTelemetryHaystack(entry);
    const kinds = this.extractTelemetryMeasurementKinds(haystack);

    if (this.isDedicatedTankStorageField(entry, subject)) {
      return true;
    }

    if (!kinds.has('level')) {
      return false;
    }

    return (
      /\btank\b/i.test(haystack) &&
      this.entryMatchesStoredFluidSubject(entry, subject) &&
      !/\b(used|consumed|consumption|rate|flow|pressure)\b/i.test(haystack)
    );
  }

  private hasSpecificTankReference(normalizedQuery: string): boolean {
    return (
      /\btank\s+\d{1,3}[a-z]{0,2}\b/i.test(normalizedQuery) ||
      /\btank\s+\d{1,3}\s+[a-z]{1,2}\b/i.test(normalizedQuery)
    );
  }

  private isElectricalCurrentQuery(normalizedQuery: string): boolean {
    return (
      /\b(currents|amps?|amperage|rms current|phase current|current on phase|current phase|line current|ac current|dc current|current draw|charge current|charging current|discharge current|neutral current|starter current|alternator current)\b/i.test(
        normalizedQuery,
      ) ||
      /\b(battery|motor|generator|pump|inverter|charger|load)\s+current\b/i.test(
        normalizedQuery,
      ) ||
      /\b(battery|motor|generator|pump|inverter|charger|load|electrical|ac|dc)\b[\s\S]{0,80}\bcurrent\b/i.test(
        normalizedQuery,
      ) ||
      /\bvoltage\s+(?:and|or|with|\/)\s+current\b/i.test(normalizedQuery) ||
      /\bcurrent\s+(?:and|or|with|\/)\s+voltage\b/i.test(normalizedQuery)
    );
  }

  private getDedicatedTankDisplayLabel(
    entry: ShipTelemetryEntry,
  ): string | null {
    const fieldText = this.getDedicatedTankFieldText(entry);
    if (!fieldText) {
      return null;
    }

    return fieldText.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private getDedicatedTankFieldText(entry: ShipTelemetryEntry): string | null {
    const rawField =
      entry.field?.trim() || entry.label?.split('.').slice(-1)[0]?.trim() || '';
    if (!rawField) {
      return null;
    }

    const fieldText = this.normalizeTelemetryText(rawField);
    if (!fieldText || !/\btank\b/i.test(fieldText)) {
      return null;
    }

    if (
      /\b(pump|filter|room|scupper|sensor|switch|alarm|temperature|temp|pressure|rate|flow|used|consumed|consumption|power|voltage|current|energy|factor)\b/i.test(
        fieldText,
      )
    ) {
      return null;
    }

    const looksLikeDedicatedTankField =
      /^((fresh|dirty|clean|black|grey|bilge)\s+)*(fuel|oil|water|coolant|def|urea)\s+tank(\s+\d{1,3}[a-z]?)?(\s+liters?)?$/i.test(
        fieldText,
      ) ||
      /^((fresh|dirty|clean|black|grey|bilge)\s+)*(fuel|oil|water|coolant|def|urea)\s+tank\s+[a-z0-9]+$/i.test(
        fieldText,
      );

    return looksLikeDedicatedTankField ? rawField : null;
  }

  private isDedicatedTankStorageField(
    entry: ShipTelemetryEntry,
    subject: StoredFluidSubject,
  ): boolean {
    const fieldText = this.normalizeTelemetryText(
      this.getDedicatedTankFieldText(entry) ?? '',
    );
    if (!fieldText) {
      return false;
    }

    if (!this.matchesStoredFluidSubject(fieldText, subject)) {
      return false;
    }

    if (!/\btank\b/i.test(fieldText)) {
      return false;
    }
    return true;
  }

  private isHistoricalTankStorageEntry(
    entry: ShipTelemetryEntry,
    subject: StoredFluidSubject,
  ): boolean {
    return (
      this.isDirectTankStorageEntry(entry, subject) &&
      !this.isDedicatedTankTemperatureEntry(entry)
    );
  }

  private isHistoricalAggregateTankStorageEntry(
    entry: ShipTelemetryEntry,
    subject: StoredFluidSubject,
  ): boolean {
    if (!this.isDirectTankStorageEntry(entry, subject)) {
      return false;
    }

    if (!this.isDedicatedTankTemperatureEntry(entry)) {
      return true;
    }

    // Historical tank totals should trust dedicated tank identity more than
    // noisy semantic descriptions that occasionally mislabel quantity fields
    // as temperature-like.
    return (
      this.isDedicatedTankStorageField(entry, subject) &&
      this.isLikelyHistoricalTankQuantityEntry(entry)
    );
  }

  private isDedicatedTankTemperatureEntry(entry: ShipTelemetryEntry): boolean {
    const semanticText = this.normalizeTelemetryText(
      [
        entry.description ?? '',
        entry.unit ?? '',
        this.getTelemetryDisplayUnit(entry) ?? '',
      ]
        .filter(Boolean)
        .join(' '),
    );
    if (!semanticText) {
      return false;
    }

    const indicatesTemperature =
      /\b(temp|temperature|celsius|fahrenheit|degree)\b/i.test(semanticText);
    const indicatesQuantity =
      /\b(level|quantity|volume|contents?|capacity|liter|litre|gallon|m3|percent|percentage|onboard)\b/i.test(
        semanticText,
      );

    return indicatesTemperature && !indicatesQuantity;
  }

  private isLikelyHistoricalTankQuantityEntry(
    entry: ShipTelemetryEntry,
  ): boolean {
    const displayUnit = this.getTelemetryDisplayUnit(entry);
    if (displayUnit === 'liters' || displayUnit === '%') {
      return true;
    }

    const numericValue =
      typeof entry.value === 'number'
        ? entry.value
        : typeof entry.value === 'string'
          ? Number.parseFloat(entry.value)
          : null;
    if (numericValue != null && Number.isFinite(numericValue)) {
      // Dedicated tank temperatures rarely reach triple digits, while noisy
      // quantity fields mislabeled as temperature often still carry tank-volume
      // magnitudes in the hundreds or thousands.
      if (Math.abs(numericValue) >= 100) {
        return true;
      }
    }

    const semanticText = this.normalizeTelemetryText(entry.description ?? '');
    return /\b(level|quantity|volume|contents?|capacity|liter|litre|percent|percentage|onboard)\b/i.test(
      semanticText,
    );
  }

  private getTelemetryTankOrder(entry: ShipTelemetryEntry): number {
    const haystack = this.buildTelemetryHaystack(entry);
    const match = haystack.match(/\btank\s+(\d{1,3})([a-z])?\b/i);
    if (!match) {
      return Number.MAX_SAFE_INTEGER;
    }

    const number = Number.parseInt(match[1], 10);
    const side = match[2]?.toLowerCase() ?? '';
    const sideOffset = side === 'p' ? 1 : side === 's' ? 2 : 3;
    return number * 10 + sideOffset;
  }

  private truncateTelemetryLogValue(value: string, maxLength = 180): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength - 3)}...`;
  }

  private isTelemetryLocationQuery(normalizedQuery: string): boolean {
    const hasExplicitLocationTerm =
      /\b(latitude|longitude|lat|lon|coordinates?|gps|location)\b/i.test(
        normalizedQuery,
      );
    const hasVesselPositionTerm =
      /\bposition\b/i.test(normalizedQuery) &&
      !/\b(throttle|valve|switch|lever|damper|actuator|rudder|flap|fan|pump|engine|generator|genset|motor)\b/i.test(
        normalizedQuery,
      );
    const hasWhereIntent =
      /\bwhere\s+is\s+(?:the\s+)?(?:yacht|vessel|ship|boat)\b/i.test(
        normalizedQuery,
      ) || /\bwhere\s+(?:are\s+we|am\s+i)\b/i.test(normalizedQuery);

    return (
      (hasExplicitLocationTerm || hasVesselPositionTerm || hasWhereIntent) &&
      !/\b(spare|part|parts|supplier|manufacturer|quantity|reference)\b/i.test(
        normalizedQuery,
      )
    );
  }

  private hasTelemetryNavigationPositionContext(
    normalizedValue: string,
  ): boolean {
    return /\b(navigation|nav|nmea|gps|coordinate|coordinates|latitude|longitude|lat|lon|location|yacht|vessel|ship|boat|course|waypoint|route)\b/i.test(
      normalizedValue,
    );
  }

  private getTelemetryCoordinateKinds(
    entry: ShipTelemetryEntry,
  ): Set<'latitude' | 'longitude'> {
    const kinds = new Set<'latitude' | 'longitude'>();
    const haystack = this.buildTelemetryHaystack(entry);

    if (/\b(latitude|lat)\b/i.test(haystack)) {
      kinds.add('latitude');
    }
    if (/\b(longitude|lon)\b/i.test(haystack)) {
      kinds.add('longitude');
    }

    return kinds;
  }

  private shouldForceTankTelemetryClarification(
    entries: ShipTelemetryEntry[],
    normalizedQuery: string,
  ): boolean {
    if (entries.length <= 1 || !/\btank\b/i.test(normalizedQuery)) {
      return false;
    }

    const queryKinds =
      this.extractTelemetryQueryMeasurementKinds(normalizedQuery);
    const asksForTankReading =
      queryKinds.has('level') ||
      /\b(status|reading|value|available|remaining|left)\b/i.test(
        normalizedQuery,
      );
    if (!asksForTankReading) {
      return false;
    }

    const tankLabels = [
      ...new Set(
        entries
          .map(
            (entry) =>
              this.getDedicatedTankDisplayLabel(entry) ??
              this.buildTelemetrySuggestionLabel(entry),
          )
          .map((label) => this.normalizeTelemetryText(label))
          .filter((label) => /\btank\b/i.test(label)),
      ),
    ];

    if (tankLabels.length <= 1) {
      return false;
    }

    return !this.hasSpecificTankSelectorInQuery(normalizedQuery);
  }

  private findBroadTankClarificationEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): ShipTelemetryEntry[] | null {
    if (!this.shouldOfferTelemetryClarification(query, resolvedSubjectQuery)) {
      return null;
    }

    const normalizedQuery = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    if (!this.shouldForceTankTelemetryClarification(entries, normalizedQuery)) {
      return null;
    }

    const fluid = this.detectStoredFluidSubject(normalizedQuery);
    if (fluid && this.isAggregateStoredFluidQuery(normalizedQuery, fluid)) {
      return null;
    }

    const tankCandidates = entries.filter((entry) =>
      fluid
        ? this.isDirectTankStorageEntry(entry, fluid)
        : this.isAnyDirectTankStorageEntry(entry),
    );

    const uniqueCandidates = new Map<string, ShipTelemetryEntry>();
    for (const entry of tankCandidates) {
      const label = this.normalizeTelemetryText(
        this.getDedicatedTankDisplayLabel(entry) ??
          this.buildTelemetrySuggestionLabel(entry),
      );
      if (!label || uniqueCandidates.has(label)) {
        continue;
      }
      uniqueCandidates.set(label, entry);
    }

    const selectedEntries = [...uniqueCandidates.values()]
      .sort((left, right) => {
        const orderDiff =
          this.getTelemetryTankOrder(left) - this.getTelemetryTankOrder(right);
        if (orderDiff !== 0) {
          return orderDiff;
        }

        return this.buildTelemetrySuggestionLabel(left).localeCompare(
          this.buildTelemetrySuggestionLabel(right),
        );
      })
      .slice(0, 8);

    return selectedEntries.length > 1 ? selectedEntries : null;
  }

  private hasSpecificTankSelectorInQuery(normalizedQuery: string): boolean {
    return (
      /\btank\s+\d{1,3}[a-z]?\b/i.test(normalizedQuery) ||
      /\b(port|starboard|ps|stbd|sb|aft|forward|fwd|midship)\b/i.test(
        normalizedQuery,
      )
    );
  }

  private isAnyDirectTankStorageEntry(entry: ShipTelemetryEntry): boolean {
    return (['fuel', 'oil', 'water', 'coolant', 'def'] as const).some((fluid) =>
      this.isDirectTankStorageEntry(entry, { fluid }),
    );
  }

  private getExplicitTelemetryCoordinateKinds(
    entry: ShipTelemetryEntry,
  ): Set<'latitude' | 'longitude'> {
    const exactText = this.normalizeTelemetryText(
      [entry.key, entry.label, entry.measurement, entry.field]
        .filter(Boolean)
        .join(' '),
    );
    const kinds = new Set<'latitude' | 'longitude'>();

    if (/\b(latitude|lat)\b/i.test(exactText)) {
      kinds.add('latitude');
    }
    if (/\b(longitude|lon)\b/i.test(exactText)) {
      kinds.add('longitude');
    }

    return kinds;
  }

  private hasCoordinatePair(
    entries: ShipTelemetryEntry[],
    getKinds: (entry: ShipTelemetryEntry) => Set<'latitude' | 'longitude'>,
  ): boolean {
    const kinds = new Set<'latitude' | 'longitude'>();
    for (const entry of entries) {
      for (const kind of getKinds(entry)) {
        kinds.add(kind);
      }
      if (kinds.has('latitude') && kinds.has('longitude')) {
        return true;
      }
    }

    return false;
  }

  private isHistoricalFuelUsageCounter(entry: ShipTelemetryEntry): boolean {
    const rawText = [
      entry.key,
      entry.label,
      entry.measurement,
      entry.field,
      entry.description,
      entry.unit,
    ]
      .filter(Boolean)
      .join(' ');

    if (!/\bfuel\b/i.test(rawText)) {
      return false;
    }

    if (
      /\b(rate|flow|pressure|temperature|temp)\b/i.test(rawText) ||
      /\bl\/h\b/i.test(rawText) ||
      /\b(?:liters?|litres?)\s+per\s+hour\b/i.test(rawText)
    ) {
      return false;
    }

    return /\b(total fuel used|fuel used|cumulative|counter|accumulated)\b/i.test(
      rawText,
    );
  }

  private async syncLatestValuesForShip(
    shipId: string,
    organizationName: string,
  ): Promise<number> {
    const activeConfigs = await this.prisma.shipMetricsConfig.findMany({
      where: { shipId, isActive: true },
      select: { metricKey: true },
    });
    if (!activeConfigs.length) return 0;

    const values = await this.influxdb.queryLatestValues(
      activeConfigs.map((config) => config.metricKey),
      organizationName,
    );
    const valueMap = new Map(values.map((value) => [value.key, value]));
    return this.persistLatestValuesForShip(
      shipId,
      activeConfigs.map((config) => config.metricKey),
      valueMap,
    );
  }

  private async persistLatestValuesForShip(
    shipId: string,
    metricKeys: string[],
    valueMap: Map<string, InfluxMetricValue>,
  ): Promise<number> {
    const now = new Date();
    let updated = 0;

    for (const metricKey of metricKeys) {
      const value = valueMap.get(metricKey);
      if (!value) continue;

      await this.prisma.shipMetricsConfig.update({
        where: {
          shipId_metricKey: { shipId, metricKey },
        },
        data: {
          latestValue: value.value != null ? value.value : undefined,
          valueUpdatedAt: this.resolveInfluxValueUpdatedAt(value.time, now),
        },
      });
      updated++;
    }

    return updated;
  }

  private resolveInfluxValueUpdatedAt(
    sourceTime: string | null | undefined,
    fallback: Date,
  ): Date {
    if (!sourceTime?.trim()) {
      return fallback;
    }

    const parsed = new Date(sourceTime);
    if (Number.isNaN(parsed.getTime())) {
      return fallback;
    }

    return parsed;
  }

  private async reconcileShipMetrics(shipId: string, metricKeys: string[]) {
    const currentConfigs = await this.prisma.shipMetricsConfig.findMany({
      where: { shipId },
      select: { metricKey: true },
    });

    const currentMetricKeys = new Set(
      currentConfigs.map((config) => config.metricKey),
    );
    const desiredMetricKeys = new Set(metricKeys);

    const missingMetricKeys = metricKeys.filter(
      (metricKey) => !currentMetricKeys.has(metricKey),
    );
    const staleMetricKeys = [...currentMetricKeys].filter(
      (metricKey) => !desiredMetricKeys.has(metricKey),
    );

    await this.prisma.$transaction(async (tx) => {
      if (staleMetricKeys.length > 0) {
        await tx.shipMetricsConfig.deleteMany({
          where: {
            shipId,
            metricKey: { in: staleMetricKeys },
          },
        });
      }

      if (missingMetricKeys.length > 0) {
        await tx.shipMetricsConfig.createMany({
          data: missingMetricKeys.map((metricKey) => ({
            shipId,
            metricKey,
            isActive: true,
          })),
        });
      }
    });
  }

  private async countPendingDescriptions(): Promise<number> {
    return this.prisma.metricDefinition.count({
      where: {
        OR: [{ description: null }, { description: '' }],
        bucket: { not: null },
        measurement: { not: null },
        field: { not: null },
      },
    });
  }

  private scheduleDescriptionBackfill(trigger: string) {
    if (!this.metricDescriptions.isConfigured()) {
      return;
    }

    const cooldownMs = this.metricDescriptions.getBackfillCooldownMs();
    if (cooldownMs > 0) {
      this.scheduleDescriptionBackfillResume(cooldownMs, trigger);
      return;
    }

    if (this.isDescriptionBackfillRunning) {
      this.shouldRerunDescriptionBackfill = true;
      return;
    }

    this.isDescriptionBackfillRunning = true;
    setTimeout(() => {
      void this.runDescriptionBackfill(trigger);
    }, 0);
  }

  private async runDescriptionBackfill(trigger: string): Promise<void> {
    let generated = 0;
    let cooldownMs = 0;

    try {
      do {
        this.shouldRerunDescriptionBackfill = false;
        const batchResult =
          await this.generateMissingDescriptionsSequentially();
        generated += batchResult.generated;
        cooldownMs = batchResult.cooldownMs;
      } while (this.shouldRerunDescriptionBackfill && cooldownMs === 0);

      if (generated > 0) {
        this.logger.log(
          `Metric description backfill completed: generated=${generated}, trigger=${trigger}`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Metric description backfill failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isDescriptionBackfillRunning = false;
      if (cooldownMs > 0) {
        this.scheduleDescriptionBackfillResume(cooldownMs, trigger);
      }
      if (this.shouldRerunDescriptionBackfill) {
        this.scheduleDescriptionBackfill('rerun');
      }
    }
  }

  private async generateMissingDescriptionsSequentially(): Promise<DescriptionBackfillBatchResult> {
    if (!this.metricDescriptions.isConfigured()) {
      return { generated: 0, cooldownMs: 0 };
    }

    const initialCooldownMs = this.metricDescriptions.getBackfillCooldownMs();
    if (initialCooldownMs > 0) {
      return { generated: 0, cooldownMs: initialCooldownMs };
    }

    const definitions = await this.prisma.metricDefinition.findMany({
      where: {
        OR: [{ description: null }, { description: '' }],
        bucket: { not: null },
        measurement: { not: null },
        field: { not: null },
      },
      select: {
        key: true,
        label: true,
        bucket: true,
        measurement: true,
        field: true,
        unit: true,
      },
      orderBy: [{ lastSeenAt: 'desc' }, { key: 'asc' }],
    });
    if (!definitions.length) return { generated: 0, cooldownMs: 0 };

    let generated = 0;

    for (const definition of definitions) {
      const description = await this.metricDescriptions.generateDescription({
        key: definition.key,
        label: definition.label,
        bucket: definition.bucket ?? '',
        measurement: definition.measurement ?? '',
        field: definition.field ?? '',
        unit: definition.unit,
      });
      if (!description) {
        const cooldownMs = this.metricDescriptions.getBackfillCooldownMs();
        if (cooldownMs > 0) {
          return { generated, cooldownMs };
        }

        continue;
      }

      const result = await this.prisma.metricDefinition.updateMany({
        where: {
          key: definition.key,
          OR: [{ description: null }, { description: '' }],
        },
        data: { description },
      });
      generated += result.count;
    }

    return { generated, cooldownMs: 0 };
  }

  private scheduleDescriptionBackfillResume(
    cooldownMs: number,
    trigger: string,
  ) {
    const resumeAt = Date.now() + cooldownMs;
    if (
      this.descriptionBackfillResumeTimer &&
      this.descriptionBackfillResumeAt >= resumeAt
    ) {
      return;
    }

    if (this.descriptionBackfillResumeTimer) {
      clearTimeout(this.descriptionBackfillResumeTimer);
    }

    this.descriptionBackfillResumeAt = resumeAt;
    this.descriptionBackfillResumeTimer = setTimeout(() => {
      this.descriptionBackfillResumeTimer = null;
      this.descriptionBackfillResumeAt = 0;
      this.scheduleDescriptionBackfill(`${trigger}:cooldown-expired`);
    }, cooldownMs);

    this.logger.log(
      `Metric description backfill paused for ${Math.ceil(
        cooldownMs / 1000,
      )}s due to Grafana LLM cooldown (trigger=${trigger}).`,
    );
  }

  private async upsertSyncedMetric(metric: InfluxMetric, now: Date) {
    await this.prisma.metricDefinition.upsert({
      where: { key: metric.key },
      update: {
        label: metric.label,
        bucket: metric.bucket,
        measurement: metric.measurement,
        field: metric.field,
        lastSeenAt: now,
        status: 'active',
      },
      create: {
        key: metric.key,
        label: metric.label,
        bucket: metric.bucket,
        measurement: metric.measurement,
        field: metric.field,
        firstSeenAt: now,
        lastSeenAt: now,
        status: 'active',
        dataType: 'numeric',
      },
    });
  }

  private ensureShipSyncQueueRunning() {
    if (this.isShipSyncRunning) {
      return;
    }

    this.isShipSyncRunning = true;
    setTimeout(() => {
      void this.runQueuedShipSyncs();
    }, 0);
  }

  private async runQueuedShipSyncs() {
    try {
      while (this.shipSyncOrder.length > 0) {
        const nextShipId = this.shipSyncOrder.shift();
        if (!nextShipId) continue;

        const job = this.queuedShipSyncs.get(nextShipId);
        if (!job) continue;

        this.queuedShipSyncs.delete(nextShipId);
        await this.runShipMetricsSyncJob(job);
      }
    } finally {
      this.isShipSyncRunning = false;
      if (this.shipSyncOrder.length > 0) {
        this.ensureShipSyncQueueRunning();
      }
    }
  }

  private async runShipMetricsSyncJob(job: ShipMetricsSyncJob) {
    const { shipId, organizationName, activeMetricKeys } = job;

    const runningUpdate = await this.prisma.ship.updateMany({
      where: { id: shipId },
      data: {
        metricsSyncStatus: 'running',
        metricsSyncError: null,
      },
    });
    if (runningUpdate.count === 0) {
      return;
    }

    try {
      await this.syncShipMetrics(shipId, organizationName, {
        activeMetricKeys,
        syncValues: false,
      });

      await this.prisma.ship.updateMany({
        where: { id: shipId },
        data: {
          metricsSyncStatus: 'ready',
          metricsSyncError: null,
          metricsSyncedAt: new Date(),
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Ship metric sync failed';

      this.logger.error(
        `Ship metric sync failed for ${shipId} (${organizationName})`,
        error instanceof Error ? error.stack : String(error),
      );

      await this.prisma.ship.updateMany({
        where: { id: shipId },
        data: {
          metricsSyncStatus: 'failed',
          metricsSyncError: message,
        },
      });
    }
  }

  private async resumePendingShipSyncs() {
    const ships = await this.prisma.ship.findMany({
      where: {
        organizationName: { not: null },
        metricsSyncStatus: { in: ['pending', 'running'] },
      },
      select: {
        id: true,
        organizationName: true,
      },
      orderBy: { updatedAt: 'asc' },
    });

    for (const ship of ships) {
      const organizationName = ship.organizationName?.trim();
      if (!organizationName) continue;

      await this.enqueueShipMetricsSync(ship.id, organizationName);
    }
  }
}
