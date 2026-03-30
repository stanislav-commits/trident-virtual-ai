import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
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
import { CreateMetricDefinitionDto } from './dto/create-metric-definition.dto';
import { MetricDescriptionService } from './metric-description.service';
import { UpdateMetricDefinitionDto } from './dto/update-metric-definition.dto';
import type { ChatNormalizedQuery } from '../chat/chat.types';

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
};

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

interface ParsedHistoricalTelemetryRequest {
  metricQuery: string;
  operation:
    | 'point'
    | 'average'
    | 'min'
    | 'max'
    | 'sum'
    | 'delta'
    | 'position'
    | 'event';
  range: InfluxHistoricalQueryRange;
  pointInTime?: Date;
  rangeLabel: string;
  clarificationQuestion?: string;
  eventType?: 'bunkering' | 'fuel_increase';
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
    return this.prisma.metricDefinition.findMany({
      orderBy: { key: 'asc' },
      select: METRIC_SELECT,
    });
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
    if (!entries.length) {
      return {
        telemetry: {},
        totalActiveMetrics: 0,
        matchedMetrics: 0,
        prefiltered: false,
        matchMode: 'none',
        clarification: null,
      };
    }

    const requestedSampleSize = this.getRequestedTelemetrySampleSize(
      query,
      resolvedSubjectQuery,
    );
    if (requestedSampleSize != null) {
      const sampleEntries = this.pickTelemetrySampleEntries(
        entries,
        query,
        resolvedSubjectQuery,
        requestedSampleSize,
      );
      return {
        telemetry: this.toTelemetryMap(sampleEntries),
        totalActiveMetrics: entries.length,
        matchedMetrics: sampleEntries.length,
        prefiltered: true,
        matchMode: 'sample',
        clarification: null,
      };
    }

    const matchedEntries = this.findRelevantTelemetryEntries(
      entries,
      query,
      resolvedSubjectQuery,
    );

    if (matchedEntries.length > 0) {
      const matchMode = this.determineTelemetryMatchMode(
        matchedEntries,
        query,
        resolvedSubjectQuery,
      );
      return {
        telemetry: this.toTelemetryMap(matchedEntries),
        totalActiveMetrics: entries.length,
        matchedMetrics: matchedEntries.length,
        prefiltered: true,
        matchMode,
        clarification: this.buildTelemetryClarification(
          matchMode,
          matchedEntries,
          query,
          resolvedSubjectQuery,
        ),
      };
    }

    const normalizedSearchSpace = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    if (this.hasStrictTelemetryContext(normalizedSearchSpace)) {
      const fallbackEntries = this.findTelemetryFallbackEntries(
        entries,
        query,
        resolvedSubjectQuery,
      );
      const fallbackMatchMode = fallbackEntries.length > 0 ? 'related' : 'none';

      return {
        telemetry: this.toTelemetryMap(fallbackEntries),
        totalActiveMetrics: entries.length,
        matchedMetrics: fallbackEntries.length,
        prefiltered: fallbackEntries.length > 0,
        matchMode: fallbackMatchMode,
        clarification:
          fallbackEntries.length > 0
            ? this.buildTelemetryClarification(
                fallbackMatchMode,
                fallbackEntries,
                query,
                resolvedSubjectQuery,
              )
            : null,
      };
    }

    // Preserve current behaviour for small ships while avoiding massive prompt
    // dumps when thousands of metrics are active.
    if (entries.length <= 25) {
      return {
        telemetry: this.toTelemetryMap(entries),
        totalActiveMetrics: entries.length,
        matchedMetrics: 0,
        prefiltered: false,
        matchMode: 'none',
        clarification: null,
      };
    }

    const fallbackEntries = this.findTelemetryFallbackEntries(
      entries,
      query,
      resolvedSubjectQuery,
    );

    const fallbackMatchMode = fallbackEntries.length > 0 ? 'related' : 'none';
    return {
      telemetry: this.toTelemetryMap(fallbackEntries),
      totalActiveMetrics: entries.length,
      matchedMetrics: fallbackEntries.length,
      prefiltered: fallbackEntries.length > 0,
      matchMode: fallbackMatchMode,
      clarification:
        fallbackEntries.length > 0
          ? this.buildTelemetryClarification(
              fallbackMatchMode,
              fallbackEntries,
              query,
              resolvedSubjectQuery,
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

    const matchedEntries = this.findHistoricalTelemetryEntries(
      entries,
      parsedRequest,
    );
    this.logger.debug(
      `Historical telemetry matching ship=${shipId} activeEntries=${entries.length} matchedEntries=${matchedEntries.length}`,
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
            undefined,
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
    return metric;
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
    return this.prisma.metricDefinition.create({
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

    return this.prisma.metricDefinition.update({
      where: { key },
      data,
      select: METRIC_SELECT,
    });
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

  private findHistoricalTelemetryEntries(
    entries: ShipTelemetryEntry[],
    request: ParsedHistoricalTelemetryRequest,
  ): ShipTelemetryEntry[] {
    if (request.operation === 'event') {
      const normalizedMetricQuery = this.normalizeTelemetryText(
        request.metricQuery,
      );
      const fuelTankEntries = entries
        .filter((entry) => this.isDirectTankStorageEntry(entry, 'fuel'))
        .sort((left, right) => {
          const tankRank =
            this.getTelemetryTankOrder(left) -
            this.getTelemetryTankOrder(right);
          return tankRank || left.key.localeCompare(right.key);
        });
      if (fuelTankEntries.length > 0) {
        return fuelTankEntries;
      }

      return this.findRelevantTelemetryEntries(entries, normalizedMetricQuery);
    }

    if (request.operation === 'position') {
      return this.findLocationTelemetryEntries(
        entries,
        request.metricQuery,
        undefined,
      );
    }

    const searchSpace = this.normalizeTelemetryText(request.metricQuery);
    const queryKinds = this.extractTelemetryMeasurementKinds(searchSpace);
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

    return this.findRelevantTelemetryEntries(entries, request.metricQuery);
  }

  private findHistoricalAggregateTankTelemetryEntries(
    entries: ShipTelemetryEntry[],
    request: ParsedHistoricalTelemetryRequest,
    normalizedQuery?: string,
  ): ShipTelemetryEntry[] {
    if (request.operation === 'delta') {
      return [];
    }

    const explicitAggregateEntries = this.findAggregateTankTelemetryEntries(
      entries,
      request.metricQuery,
    );
    if (explicitAggregateEntries.length > 0) {
      return explicitAggregateEntries;
    }

    const searchSpace =
      normalizedQuery ?? this.normalizeTelemetryText(request.metricQuery);
    if (!this.isImplicitHistoricalFuelInventoryQuery(searchSpace)) {
      return [];
    }

    return entries
      .filter((entry) => this.isDirectTankStorageEntry(entry, 'fuel'))
      .sort((left, right) => {
        const tankRank =
          this.getTelemetryTankOrder(left) - this.getTelemetryTankOrder(right);
        return tankRank || left.key.localeCompare(right.key);
      })
      .slice(0, 16);
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
    const effectiveOperation =
      request.operation === 'sum' &&
      matchedEntries.every(
        (entry) => this.getHistoricalMetricSemanticKind(entry) === 'counter',
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
    let rows: InfluxMetricValue[] = [];
    let selectedSeriesOptions:
      | (InfluxHistoricalSeriesOptions & { windowMs: number })
      | undefined;
    const coarseSeriesOptionCandidates = this.getHistoricalEventSeriesOptions(
      request.range,
    );

    if (coarseSeriesOptionCandidates.length === 0) {
      rows = await this.influxdb.queryHistoricalSeries(
        seriesKeys,
        request.range,
        organizationName,
      );
    } else {
      let lastError: Error | null = null;
      for (const candidate of coarseSeriesOptionCandidates) {
        try {
          rows = await this.influxdb.queryHistoricalSeries(
            seriesKeys,
            request.range,
            organizationName,
            candidate,
          );
          selectedSeriesOptions = candidate;
          if (rows.length > 0) {
            break;
          }
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          this.logger.warn(
            `Historical event series query failed for window=${candidate.windowEvery}. ${lastError.message}`,
          );
        }
      }

      if (rows.length === 0 && lastError) {
        throw lastError;
      }
    }

    if (rows.length === 0) {
      return null;
    }

    let positiveEvents = this.detectHistoricalPositiveEvents(
      matchedEntries,
      rows,
    );
    if (
      positiveEvents.length > 0 &&
      selectedSeriesOptions?.windowEvery &&
      selectedSeriesOptions.windowMs > 0
    ) {
      const refinementRange = this.buildHistoricalEventRefinementRange(
        request.range,
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
        { windowEvery: '12h', windowMs: 12 * 60 * 60 * 1000 },
        { windowEvery: '1d', windowMs: 24 * 60 * 60 * 1000 },
      ];
    }
    if (durationMs > 30 * 24 * 60 * 60 * 1000) {
      return [
        { windowEvery: '6h', windowMs: 6 * 60 * 60 * 1000 },
        { windowEvery: '12h', windowMs: 12 * 60 * 60 * 1000 },
      ];
    }
    if (durationMs > 7 * 24 * 60 * 60 * 1000) {
      return [
        { windowEvery: '2h', windowMs: 2 * 60 * 60 * 1000 },
        { windowEvery: '6h', windowMs: 6 * 60 * 60 * 1000 },
      ];
    }

    return [
      { windowEvery: '30m', windowMs: 30 * 60 * 1000 },
      { windowEvery: '2h', windowMs: 2 * 60 * 60 * 1000 },
    ];
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
          delta: last - first,
        };
      })
      .filter(
        (
          value,
        ): value is {
          entry: ShipTelemetryEntry;
          delta: number;
        } => Boolean(value),
      );

    if (deltas.length === 0) {
      return null;
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
    const missingYearFragment = this.findHistoricalDateWithoutYear(searchSpace);
    if (missingYearFragment) {
      return {
        metricQuery: this.sanitizeHistoricalMetricQuery(query),
        operation,
        range: { start: new Date(), stop: new Date() },
        rangeLabel: '',
        clarificationQuestion: `Which year do you mean for ${missingYearFragment}?`,
      };
    }

    const relativeRange = this.parseRelativeHistoricalRange(searchSpace);
    const explicitDate = this.parseExplicitHistoricalDate(searchSpace);
    const explicitTime = this.parseHistoricalTimeOfDay(searchSpace);
    const relativePointInTime = this.parseRelativeHistoricalPoint(
      searchSpace,
      normalizedQuery,
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
      };
    }

    if (!relativeRange && !explicitDate && !relativePointInTime) {
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
      };
    }

    const range =
      relativeRange ?? this.buildFullDayHistoricalRange(explicitDate!);
    return {
      metricQuery,
      operation,
      range,
      rangeLabel: this.formatHistoricalRange(range),
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
    | 'delta'
    | 'position'
    | 'event' {
    if (positionQuery) {
      return 'position';
    }

    if (normalizedQuery?.operation === 'event') {
      return 'event';
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
    if (
      /\b(used|consumed|consumption|difference|delta|increase|decrease)\b/i.test(
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
    const clockMatch = query.match(
      /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i,
    );
    if (!clockMatch) {
      return null;
    }

    let hours = Number.parseInt(clockMatch[1], 10);
    const minutes = Number.parseInt(clockMatch[2] ?? '0', 10);
    const meridiem = clockMatch[3]?.toLowerCase();
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
        /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/gi,
        ' ',
      )
      .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
      .replace(
        /\b(?:last|past|previous|over the last|today|yesterday|this week|last week|this month|last month|between|from|to|on|at|during|for)\b/gi,
        ' ',
      )
      .replace(/\b(?:what|was|were|is|the|please|show|give|tell|me)\b/gi, ' ')
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

  private findRelevantTelemetryEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): ShipTelemetryEntry[] {
    const aggregateTankEntries = this.findAggregateTankTelemetryEntries(
      entries,
      query,
      resolvedSubjectQuery,
    );
    if (aggregateTankEntries.length > 0) {
      return aggregateTankEntries;
    }

    const locationEntries = this.findLocationTelemetryEntries(
      entries,
      query,
      resolvedSubjectQuery,
    );
    if (locationEntries.length > 0) {
      return locationEntries;
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

    return this.filterScoredTelemetryEntries(narrowed)
      .slice(0, 12)
      .map((candidate) => candidate.entry);
  }

  private findAggregateTankTelemetryEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): ShipTelemetryEntry[] {
    const searchSpace = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
    const fluid = this.detectStoredFluidSubject(searchSpace);
    if (!fluid || !this.isAggregateStoredFluidQuery(searchSpace, fluid)) {
      return [];
    }

    const selected = entries
      .filter((entry) => this.isDirectTankStorageEntry(entry, fluid))
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
    const queryKinds = this.extractTelemetryMeasurementKinds(searchSpace);
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
        const entryKinds = this.extractTelemetryMeasurementKinds(haystack);
        return [...queryKinds].some((kind) => entryKinds.has(kind));
      }
      return false;
    });

    if (filtered.length === 0 && this.hasStrictTelemetryContext(searchSpace)) {
      return [];
    }

    return filtered.slice(0, 8);
  }

  private getRequestedTelemetrySampleSize(
    query: string,
    resolvedSubjectQuery?: string,
  ): number | null {
    const normalized = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );

    if (
      !/\b(show|list|display|give|return|output)\b/i.test(normalized) ||
      !/\b(metrics?|telemetry|readings?|values?)\b/i.test(normalized)
    ) {
      return null;
    }

    const countMatch = normalized.match(/\b(\d{1,2})\b/);
    if (countMatch) {
      const parsed = Number.parseInt(countMatch[1], 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.min(parsed, 25);
      }
    }

    return 10;
  }

  private buildTelemetryQuerySignals(
    query: string,
    resolvedSubjectQuery?: string,
  ): {
    normalizedQuery: string;
    tokens: string[];
    phrases: string[];
  } {
    const normalizedQuery = this.normalizeTelemetryText(
      `${query}\n${resolvedSubjectQuery ?? ''}`,
    );
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
          .filter((token) => !stopWords.has(token)),
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
    const queryKinds = this.extractTelemetryMeasurementKinds(query);
    const entryKinds = this.extractTelemetryMeasurementKinds(haystack);
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
  ): ShipTelemetryEntry[] {
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

    return [...samplePool]
      .sort((left, right) => {
        const leftScore = this.rankTelemetryEntryForSample(left, seed);
        const rightScore = this.rankTelemetryEntryForSample(right, seed);
        return rightScore - leftScore || left.key.localeCompare(right.key);
      })
      .slice(0, cappedLimit);
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

    const queryKinds = this.extractTelemetryMeasurementKinds(
      querySignals.normalizedQuery,
    );
    const subjectTokens = this.getTelemetrySubjectTokens(querySignals.tokens);

    if (queryKinds.size === 0 || subjectTokens.length === 0) {
      const contextMatched = scored.filter((candidate) =>
        this.matchesTelemetrySpecificContext(
          candidate.entry,
          querySignals.normalizedQuery,
        ),
      );
      if (contextMatched.length > 0) {
        return contextMatched;
      }
      return this.hasStrictTelemetryContext(querySignals.normalizedQuery)
        ? []
        : scored;
    }

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

    const withSubject = searchSpace.filter((candidate) =>
      this.matchesTelemetrySubject(candidate.entry, subjectTokens),
    );
    const withSubjectAndKind = withSubject.filter((candidate) =>
      this.matchesTelemetryKinds(candidate.entry, queryKinds),
    );

    if (withSubjectAndKind.length > 0) {
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

    const queryKinds = this.extractTelemetryMeasurementKinds(normalizedQuery);
    const subjectTokens = this.getTelemetrySubjectTokens(
      this.buildTelemetryQuerySignals(query, resolvedSubjectQuery).tokens,
    );
    if (queryKinds.size === 0) {
      return 'direct';
    }

    const hasDirectMeasurementKind = entries.some((entry) => {
      const entryKinds = this.extractTelemetryMeasurementKinds(
        this.buildTelemetryHaystack(entry),
      );
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
      const entryKinds = this.extractTelemetryMeasurementKinds(haystack);
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
  ): ShipTelemetryContext['clarification'] {
    if (matchMode !== 'related') {
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
        "I couldn't find a direct telemetry metric that exactly measures the requested reading, but I did find related metrics for the same topic. Which one do you want to inspect?",
      pendingQuery: this.buildTelemetryClarificationPendingQuery(query),
      actions,
    };
  }

  private shouldOfferTelemetryClarification(
    query: string,
    resolvedSubjectQuery?: string,
  ): boolean {
    if (
      this.getRequestedTelemetrySampleSize(query, resolvedSubjectQuery) != null
    ) {
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
    const checks: Array<[RegExp, string]> = [
      [/\b(level)\b/i, 'level'],
      [/\b(temp|temperature)\b/i, 'temperature'],
      [/\b(pressure)\b/i, 'pressure'],
      [/\b(voltage)\b/i, 'voltage'],
      [/\b(amperage|amps?)\b/i, 'current'],
      [/\b(load)\b/i, 'load'],
      [/\b(rpm|speed)\b/i, 'speed'],
      [/\b(flow|rate)\b/i, 'flow'],
      [/\b(runtime|running|hours?|hour\s*meter)\b/i, 'hours'],
      [/\b(status(?:es)?|state(?:s)?)\b/i, 'status'],
      [
        /\b(latitude|longitude|coordinates?|position|gps|location|lat|lon)\b/i,
        'location',
      ],
    ];

    for (const [pattern, label] of checks) {
      if (pattern.test(value)) {
        kinds.add(label);
      }
    }

    const normalized = this.normalizeTelemetryText(value);
    const asksForStoredQuantity =
      /\b(how much|how many|onboard|remaining|left|available)\b/i.test(
        normalized,
      ) &&
      /\b(fuel|oil|coolant|water|tank|def|urea)\b/i.test(normalized) &&
      !/\b(used|consumed|consumption|rate|flow)\b/i.test(normalized);
    if (asksForStoredQuantity) {
      kinds.add('level');
    }

    if (/\b(volume|quantity|contents?)\b/i.test(normalized)) {
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
      ) && !/\b(used|consumed|consumption|rate|flow)\b/i.test(normalized);
    if (hasQuantityUnit) {
      kinds.add('level');
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

    const entryKinds = this.extractTelemetryMeasurementKinds(
      this.buildTelemetryHaystack(entry),
    );
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
      .replace(/\bright\b/g, ' starboard ')
      .replace(/\bleft\b/g, ' port ')
      .replace(/\bgenerator\s+set\b/g, ' genset ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
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
      'current',
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
      status: 'status',
      statuses: 'status',
      states: 'state',
      volts: 'voltage',
      volt: 'voltage',
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
    const mentionsEngineRoom = /\bengine room\b/i.test(normalizedQuery);
    const mentionsGenerator = /\b(generator|genset)\b/i.test(normalizedQuery);
    const mentionsMainEngine =
      /\bengine\b/i.test(normalizedQuery) &&
      !mentionsEngineRoom &&
      !mentionsGenerator;

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

    return true;
  }

  private containsLoosely(left: string, right: string): boolean {
    return this.normalizeTelemetryText(left).includes(
      this.normalizeTelemetryText(right),
    );
  }

  private detectStoredFluidSubject(
    normalizedQuery: string,
  ): 'fuel' | 'oil' | 'water' | 'coolant' | 'def' | null {
    if (/\bfuel\b/i.test(normalizedQuery)) return 'fuel';
    if (/\boil\b/i.test(normalizedQuery)) return 'oil';
    if (/\bcoolant\b/i.test(normalizedQuery)) return 'coolant';
    if (/\b(def|urea)\b/i.test(normalizedQuery)) return 'def';
    if (/\b(water|fresh water|seawater)\b/i.test(normalizedQuery))
      return 'water';
    return null;
  }

  private isAggregateStoredFluidQuery(
    normalizedQuery: string,
    fluid: 'fuel' | 'oil' | 'water' | 'coolant' | 'def',
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
      (fluid === 'fuel' && /\bonboard\b/i.test(normalizedQuery));

    return mentionsTankContext;
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

  private isDirectTankStorageEntry(
    entry: ShipTelemetryEntry,
    fluid: 'fuel' | 'oil' | 'water' | 'coolant' | 'def',
  ): boolean {
    const haystack = this.buildTelemetryHaystack(entry);
    const kinds = this.extractTelemetryMeasurementKinds(haystack);
    const fluidPattern =
      fluid === 'water'
        ? /\b(water|fresh water|seawater)\b/i
        : fluid === 'def'
          ? /\b(def|urea)\b/i
          : new RegExp(`\\b${fluid}\\b`, 'i');

    if (this.isDedicatedTankStorageField(entry, fluid)) {
      return true;
    }

    if (!kinds.has('level')) {
      return false;
    }

    return (
      /\btank\b/i.test(haystack) &&
      fluidPattern.test(haystack) &&
      !/\b(used|consumed|consumption|rate|flow|pressure)\b/i.test(haystack)
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
    fluid: 'fuel' | 'oil' | 'water' | 'coolant' | 'def',
  ): boolean {
    const fieldText = this.normalizeTelemetryText(
      this.getDedicatedTankFieldText(entry) ?? '',
    );
    if (!fieldText) {
      return false;
    }

    const fluidPattern =
      fluid === 'water'
        ? /\b(water|fresh water|seawater)\b/i
        : fluid === 'def'
          ? /\b(def|urea)\b/i
          : new RegExp(`\\b${fluid}\\b`, 'i');
    if (!fluidPattern.test(fieldText)) {
      return false;
    }

    if (!/\btank\b/i.test(fieldText)) {
      return false;
    }
    return true;
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
    return (
      /\b(latitude|longitude|lat|lon|coordinates?|position|gps|location)\b/i.test(
        normalizedQuery,
      ) &&
      !/\b(spare|part|parts|supplier|manufacturer|quantity|reference)\b/i.test(
        normalizedQuery,
      )
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
