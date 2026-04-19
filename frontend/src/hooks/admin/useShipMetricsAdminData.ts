import { useCallback, useEffect, useState } from "react";
import {
  getShipMetricsCatalog,
  syncShipMetricsCatalog,
  updateShipMetricDescription,
  type ShipMetricCatalogItem,
  type ShipMetricsCatalog,
  type ShipMetricsSyncResult,
} from "../../api/metricsApi";

interface SyncShipMetricsOptions {
  silent?: boolean;
}

export interface ShipMetricsAdminData {
  catalog: ShipMetricsCatalog | null;
  loading: boolean;
  syncing: boolean;
  error: string;
  setError: (nextError: string) => void;
  refreshCatalog: () => Promise<void>;
  syncCatalog: (options?: SyncShipMetricsOptions) => Promise<void>;
  updateDescription: (
    metricId: string,
    description: string | null,
  ) => Promise<ShipMetricCatalogItem | null>;
  lastSyncResult: ShipMetricsSyncResult | null;
}

export function useShipMetricsAdminData(
  token: string | null,
  shipId: string | null,
  enabled: boolean,
): ShipMetricsAdminData {
  const [catalog, setCatalog] = useState<ShipMetricsCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [lastSyncResult, setLastSyncResult] =
    useState<ShipMetricsSyncResult | null>(null);

  const refreshCatalog = useCallback(async () => {
    if (!enabled || !token || !shipId) {
      setCatalog(null);
      setLoading(false);
      return;
    }

    setLoading(true);

    try {
      const nextCatalog = await getShipMetricsCatalog(shipId, token);
      setCatalog(nextCatalog);
    } catch (catalogError) {
      setError(
        catalogError instanceof Error
          ? catalogError.message
          : "Failed to load ship metrics",
      );
    } finally {
      setLoading(false);
    }
  }, [enabled, shipId, token]);

  const syncCatalog = useCallback(
    async (options: SyncShipMetricsOptions = {}) => {
      if (!enabled || !token || !shipId) {
        return;
      }

      setSyncing(true);

      if (!options.silent) {
        setError("");
      }

      try {
        const result = await syncShipMetricsCatalog(shipId, token);
        setLastSyncResult(result);
        const nextCatalog = await getShipMetricsCatalog(shipId, token);
        setCatalog(nextCatalog);
      } catch (syncError) {
        setError(
          syncError instanceof Error
            ? syncError.message
            : "Failed to sync ship metrics",
        );
      } finally {
        setSyncing(false);
      }
    },
    [enabled, shipId, token],
  );

  const updateDescription = useCallback(
    async (metricId: string, description: string | null) => {
      if (!token) {
        return null;
      }

      try {
        const updatedMetric = await updateShipMetricDescription(
          metricId,
          description,
          token,
        );

        setCatalog((currentCatalog) => {
          if (!currentCatalog) {
            return currentCatalog;
          }

          return {
            ...currentCatalog,
            buckets: currentCatalog.buckets.map((bucketGroup) => ({
              ...bucketGroup,
              metrics: bucketGroup.metrics.map((metric) =>
                metric.id === updatedMetric.id ? updatedMetric : metric,
              ),
            })),
          };
        });

        return updatedMetric;
      } catch (updateError) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : "Failed to update metric description",
        );
        return null;
      }
    },
    [token],
  );

  useEffect(() => {
    if (!enabled || !token || !shipId) {
      setCatalog(null);
      setLastSyncResult(null);
      setLoading(false);
      setSyncing(false);
      setError("");
      return;
    }

    setError("");
    setLastSyncResult(null);
    void refreshCatalog();
  }, [enabled, refreshCatalog, shipId, token]);

  return {
    catalog,
    loading,
    syncing,
    error,
    setError,
    refreshCatalog,
    syncCatalog,
    updateDescription,
    lastSyncResult,
  };
}
