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

@Injectable()
export class MetricsService implements OnModuleInit {
  private readonly logger = new Logger(MetricsService.name);
  private isDescriptionBackfillRunning = false;
  private shouldRerunDescriptionBackfill = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly influxdb: InfluxdbService,
    private readonly metricDescriptions: MetricDescriptionService,
  ) {}

  onModuleInit() {
    this.scheduleDescriptionBackfill('startup');
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
    const configs = await this.prisma.shipMetricsConfig.findMany({
      where: { shipId, isActive: true },
      select: {
        latestValue: true,
        metric: {
          select: {
            description: true,
            measurement: true,
            field: true,
          },
        },
      },
    });

    if (!configs.length) return {};

    const telemetry: Record<string, string | number | boolean | null> = {};
    for (const config of configs) {
      const label =
        config.metric?.description ||
        `${config.metric?.measurement ?? ''} - ${config.metric?.field ?? ''}`;
      telemetry[label] =
        (config.latestValue as string | number | boolean | null) ?? null;
    }

    return telemetry;
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
}
