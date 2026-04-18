import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  InfluxMetricValue,
  InfluxdbService,
} from '../../influxdb/influxdb.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { MetricsValuesSyncResult } from './metrics-sync.types';

@Injectable()
export class MetricsValuesSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly influxdb: InfluxdbService,
  ) {}

  async syncValuesFromInflux(): Promise<MetricsValuesSyncResult> {
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

  async syncLatestValuesForShip(
    shipId: string,
    organizationName: string,
  ): Promise<number> {
    const activeConfigs = await this.prisma.shipMetricsConfig.findMany({
      where: { shipId, isActive: true },
      select: { metricKey: true },
    });
    if (!activeConfigs.length) {
      return 0;
    }

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
}
