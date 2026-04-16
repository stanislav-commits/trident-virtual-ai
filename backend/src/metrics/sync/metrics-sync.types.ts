import type { InfluxMetric } from '../../influxdb/influxdb.service';

export interface SyncShipMetricsOptions {
  metrics?: InfluxMetric[];
  activeMetricKeys?: string[];
  scheduleDescriptions?: boolean;
  syncValues?: boolean;
}

export interface DescriptionBackfillBatchResult {
  generated: number;
  cooldownMs: number;
}

export interface ShipMetricsSyncJob {
  shipId: string;
  organizationName: string;
  activeMetricKeys?: string[];
}
