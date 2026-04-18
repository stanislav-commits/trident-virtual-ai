import type { InfluxMetric } from '../../influxdb/influxdb.service';

export interface SyncShipMetricsOptions {
  metrics?: InfluxMetric[];
  activeMetricKeys?: string[];
  syncValues?: boolean;
}

export interface ShipMetricsSyncJob {
  shipId: string;
  organizationName: string;
  activeMetricKeys?: string[];
}

export interface MetricsCatalogRescanResult {
  shipsSynced: number;
  organizations: string[];
  buckets: string[];
  metricsSynced: number;
}

export interface MetricsValuesSyncResult {
  shipsSynced: number;
  organizations: string[];
  buckets: string[];
  metricsQueried: number;
  valuesUpdated: number;
}

export interface MetricsShipCatalogSyncResult {
  organizationName: string;
  buckets: string[];
  metricsSynced: number;
  valuesUpdated: number;
}
