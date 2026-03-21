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
  InfluxdbService,
} from '../influxdb/influxdb.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMetricDefinitionDto } from './dto/create-metric-definition.dto';
import { MetricDescriptionService } from './metric-description.service';
import { UpdateMetricDefinitionDto } from './dto/update-metric-definition.dto';

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
  value: string | number | boolean | null;
  updatedAt?: Date | null;
}

interface ShipTelemetryContext {
  telemetry: Record<string, string | number | boolean | null>;
  totalActiveMetrics: number;
  matchedMetrics: number;
  prefiltered: boolean;
  matchMode: 'none' | 'sample' | 'exact' | 'direct' | 'related';
}

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly logger = new Logger(MetricsService.name);
  private isDescriptionBackfillRunning = false;
  private shouldRerunDescriptionBackfill = false;
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
          organizationShips.flatMap((ship) =>
            ship.metricKeys.filter(Boolean),
          ),
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
    const result = await this.syncShipMetricCatalog(shipId, normalizedOrganizationName, {
      ...options,
      metrics,
    });

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
      };
    }

    const matchedEntries = this.findRelevantTelemetryEntries(
      entries,
      query,
      resolvedSubjectQuery,
    );

    if (matchedEntries.length > 0) {
      return {
        telemetry: this.toTelemetryMap(matchedEntries),
        totalActiveMetrics: entries.length,
        matchedMetrics: matchedEntries.length,
        prefiltered: true,
        matchMode: this.determineTelemetryMatchMode(
          matchedEntries,
          query,
          resolvedSubjectQuery,
        ),
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
      };
    }

    const fallbackEntries = this.findTelemetryFallbackEntries(
      entries,
      query,
      resolvedSubjectQuery,
    );

    return {
      telemetry: this.toTelemetryMap(fallbackEntries),
      totalActiveMetrics: entries.length,
      matchedMetrics: fallbackEntries.length,
      prefiltered: fallbackEntries.length > 0,
      matchMode: fallbackEntries.length > 0 ? 'related' : 'none',
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
      value: (config.latestValue as string | number | boolean | null) ?? null,
      updatedAt: config.valueUpdatedAt,
    }));
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
    const primary =
      entry.measurement && entry.field
        ? `${entry.measurement}.${entry.field}`
        : entry.label || entry.key;

    const extras = [
      entry.description,
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

  private findRelevantTelemetryEntries(
    entries: ShipTelemetryEntry[],
    query: string,
    resolvedSubjectQuery?: string,
  ): ShipTelemetryEntry[] {
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
    const wantsHours = /\b(hours?|runtime|running|hour\s*meter|operating)\b/i.test(
      searchSpace,
    );
    const wantsCurrentValue = queryKinds.size > 0;

    const filtered = entries.filter((entry) => {
      const haystack = this.buildTelemetryHaystack(entry);
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
      'be',
      'been',
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
      'i',
      'in',
      'into',
      'it',
      'its',
      'list',
      'lookup',
      'me',
      'my',
      'of',
      'on',
      'or',
      'our',
      'out',
      'output',
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
      'recommended',
      'recommendation',
      'related',
      'latest',
      'metric',
      'metrics',
      'telemetry',
      'readings',
      'values',
      'active',
      'connected',
      'enabled',
      'random',
      'their',
      'with',
      'from',
      'up',
      'us',
      'using',
      'we',
      'were',
      'will',
      'would',
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
    querySignals: { normalizedQuery: string; tokens: string[]; phrases: string[] },
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
      haystack.includes(token),
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
    querySignals: { normalizedQuery: string; tokens: string[]; phrases: string[] },
  ): Array<{ entry: ShipTelemetryEntry; score: number }> {
    return entries
      .map((entry) => ({
        entry,
        score: this.scoreTelemetryEntry(entry, querySignals),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.entry.key.localeCompare(right.entry.key),
      );
  }

  private filterTelemetryCandidatesByQuery(
    scored: Array<{ entry: ShipTelemetryEntry; score: number }>,
    querySignals: { normalizedQuery: string; tokens: string[]; phrases: string[] },
  ): Array<{ entry: ShipTelemetryEntry; score: number }> {
    if (scored.length === 0) {
      return [];
    }

    const queryKinds = this.extractTelemetryMeasurementKinds(
      querySignals.normalizedQuery,
    );
    const subjectTokens = this.getTelemetrySubjectTokens(querySignals.tokens);

    if (queryKinds.size === 0 || subjectTokens.length === 0) {
      return scored;
    }

    const withSubject = scored.filter((candidate) =>
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

    const withKind = scored.filter((candidate) =>
      this.matchesTelemetryKinds(candidate.entry, queryKinds),
    );
    return withKind.length > 0 ? withKind : scored;
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

    if (
      exactCandidates.some(
        (candidate) =>
          candidate === normalizedQuery || normalizedQuery.includes(candidate),
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
      const matchesSubject = subjectTokens.some((token) => haystack.includes(token));
      return matchesSubject && [...queryKinds].some((kind) => entryKinds.has(kind));
    });

    return hasDirectSubjectAndKind ? 'direct' : 'related';
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
      [/\b(status|state)\b/i, 'status'],
    ];

    for (const [pattern, label] of checks) {
      if (pattern.test(value)) {
        kinds.add(label);
      }
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
      haystack.includes(token),
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
      .replace(/\bgenerator\s+set\b/g, ' genset ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private getTelemetrySubjectTokens(tokens: string[]): string[] {
    return tokens.filter((token) => !this.isTelemetryKindToken(token));
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
      'level',
      'load',
      'pressure',
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
      ['port', 'ps'],
      ['starboard', 'sb'],
      ['temperature', 'temp'],
    ];

    for (const group of aliasGroups) {
      if (group.includes(token)) {
        group.forEach((variant) => variants.add(variant));
      }
    }

    return [...variants];
  }

  private containsLoosely(left: string, right: string): boolean {
    return this.normalizeTelemetryText(left).includes(
      this.normalizeTelemetryText(right),
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
          valueUpdatedAt: now,
        },
      });
      updated++;
    }

    return updated;
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

    try {
      do {
        this.shouldRerunDescriptionBackfill = false;
        generated += await this.generateMissingDescriptionsSequentially();
      } while (this.shouldRerunDescriptionBackfill);

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
      if (this.shouldRerunDescriptionBackfill) {
        this.scheduleDescriptionBackfill('rerun');
      }
    }
  }

  private async generateMissingDescriptionsSequentially(): Promise<number> {
    if (!this.metricDescriptions.isConfigured()) {
      return 0;
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
      },
      orderBy: [{ lastSeenAt: 'desc' }, { key: 'asc' }],
    });
    if (!definitions.length) return 0;

    let generated = 0;

    for (const definition of definitions) {
      const description =
        await this.metricDescriptions.generateDescription({
          key: definition.key,
          label: definition.label,
          bucket: definition.bucket ?? '',
          measurement: definition.measurement ?? '',
          field: definition.field ?? '',
        });
      if (!description) continue;

      const result = await this.prisma.metricDefinition.updateMany({
        where: {
          key: definition.key,
          OR: [{ description: null }, { description: '' }],
        },
        data: { description },
      });
      generated += result.count;
    }

    return generated;
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
