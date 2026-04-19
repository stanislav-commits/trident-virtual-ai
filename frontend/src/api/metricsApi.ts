import { fetchWithAuth } from "./core";

export interface ShipMetricCatalogItem {
  id: string;
  key: string;
  bucket: string;
  field: string;
  description: string | null;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShipMetricBucketGroup {
  bucket: string;
  metrics: ShipMetricCatalogItem[];
  totalMetrics: number;
}

export interface ShipMetricsCatalog {
  ship: {
    id: string;
    name: string;
    organizationName: string | null;
  };
  totalMetrics: number;
  syncedAt: string | null;
  buckets: ShipMetricBucketGroup[];
}

export interface ShipMetricsSyncResult {
  shipId: string;
  shipName: string;
  organizationName: string;
  bucketCount: number;
  buckets: string[];
  metricsSynced: number;
  staleMetricsRemoved: number;
  syncedAt: string;
}

export async function getShipMetricsCatalog(
  shipId: string,
  token: string,
): Promise<ShipMetricsCatalog> {
  const response = await fetchWithAuth(`metrics/ships/${shipId}/catalog`, {
    token,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to load ship metrics");
  }

  return response.json();
}

export async function syncShipMetricsCatalog(
  shipId: string,
  token: string,
): Promise<ShipMetricsSyncResult> {
  const response = await fetchWithAuth(`metrics/ships/${shipId}/sync`, {
    token,
    method: "POST",
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to sync ship metrics");
  }

  return response.json();
}

export async function updateShipMetricDescription(
  metricId: string,
  description: string | null,
  token: string,
): Promise<ShipMetricCatalogItem> {
  const response = await fetchWithAuth(`metrics/catalog/${metricId}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ description }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(
      errorBody.message ?? "Failed to update metric description",
    );
  }

  return response.json();
}
