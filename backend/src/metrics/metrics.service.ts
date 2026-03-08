import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  InfluxMetric,
  InfluxMetricValue,
  InfluxdbService,
} from '../influxdb/influxdb.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMetricDefinitionDto } from './dto/create-metric-definition.dto';
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

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly influxdb: InfluxdbService,
  ) {}

  async syncFromInflux() {
    if (!this.influxdb.isConfigured()) {
      throw new ServiceUnavailableException(
        'InfluxDB is not configured. Set INFLUX_URL, INFLUX_TOKEN and INFLUX_ORG',
      );
    }

    const metrics = await this.influxdb.listAllMetrics();
    const buckets = this.influxdb.getBuckets();
    const now = new Date();

    // 1. Sync metric definitions (keys, labels, buckets, etc.)
    for (const metric of metrics) {
      await this.upsertSyncedMetric(metric, now);
    }

    const keys = metrics.map((metric) => metric.key);
    if (keys.length > 0) {
      await this.prisma.metricDefinition.updateMany({
        where: {
          bucket: { in: buckets },
          key: { notIn: keys },
        },
        data: { status: 'deprecated' },
      });
    }

    // 2. Sync latest values into ShipMetricsConfig for all active assignments
    const valuesUpdated = await this.syncLatestValues();

    return {
      buckets,
      metricsSynced: keys.length,
      valuesUpdated,
    };
  }

  /**
   * Fetch latest values from InfluxDB and store them in ShipMetricsConfig.
   */
  private async syncLatestValues(): Promise<number> {
    const activeConfigs = await this.prisma.shipMetricsConfig.findMany({
      where: { isActive: true },
      select: { shipId: true, metricKey: true },
    });
    if (!activeConfigs.length) return 0;

    const allKeys = [...new Set(activeConfigs.map((c) => c.metricKey))];
    const values = await this.influxdb.queryLatestValues(allKeys);
    const valMap = new Map(values.map((v) => [v.key, v]));

    let updated = 0;
    const now = new Date();

    for (const cfg of activeConfigs) {
      const v = valMap.get(cfg.metricKey);
      if (!v) continue;

      await this.prisma.shipMetricsConfig.update({
        where: {
          shipId_metricKey: { shipId: cfg.shipId, metricKey: cfg.metricKey },
        },
        data: {
          latestValue: v.value != null ? v.value : undefined,
          valueUpdatedAt: now,
        },
      });
      updated++;
    }

    return updated;
  }

  async findAll() {
    return this.prisma.metricDefinition.findMany({
      orderBy: { key: 'asc' },
      select: METRIC_SELECT,
    });
  }

  /**
   * Fetch the latest real-time values for given metric keys from InfluxDB.
   */
  async getLatestValues(keys: string[]): Promise<InfluxMetricValue[]> {
    if (!this.influxdb.isConfigured() || !keys.length) return [];
    return this.influxdb.queryLatestValues(keys);
  }

  /**
   * Fetch latest telemetry for a ship from cached values in ShipMetricsConfig.
   * Returns a label→value map suitable for the LLM context.
   */
  async getShipTelemetry(
    shipId: string,
  ): Promise<Record<string, string | number | boolean | null>> {
    const configs = await this.prisma.shipMetricsConfig.findMany({
      where: { shipId, isActive: true },
      select: {
        latestValue: true,
        metric: {
          select: { description: true, measurement: true, field: true },
        },
      },
    });
    if (!configs.length) return {};

    const result: Record<string, string | number | boolean | null> = {};
    for (const cfg of configs) {
      const label =
        cfg.metric?.description ||
        `${cfg.metric?.measurement ?? ''} — ${cfg.metric?.field ?? ''}`;
      result[label] =
        (cfg.latestValue as string | number | boolean | null) ?? null;
    }
    return result;
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
    if (dto.description !== undefined)
      data.description = dto.description?.trim() || null;
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
        // description & unit are NOT listed here — preserved across syncs
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

  private chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < items.length; i += size) {
      chunks.push(items.slice(i, i + size));
    }
    return chunks;
  }
}
