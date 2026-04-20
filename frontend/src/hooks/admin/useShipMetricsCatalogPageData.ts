import { useCallback, useEffect, useState } from "react";
import {
  getShipMetricsCatalogPage,
  syncShipMetricsCatalog,
  updateShipMetricDescription,
  type ShipMetricCatalogItem,
  type ShipMetricCatalogPage,
  type ShipMetricsSyncResult,
} from "../../api/metricsApi";

interface SyncShipMetricsOptions {
  silent?: boolean;
}

interface UseShipMetricsCatalogPageOptions {
  search: string;
  bucket: string | null;
  page: number;
  pageSize: number;
  enabled: boolean;
}

export interface ShipMetricsCatalogPageData {
  catalogPage: ShipMetricCatalogPage | null;
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

export function useShipMetricsCatalogPageData(
  token: string | null,
  shipId: string | null,
  options: UseShipMetricsCatalogPageOptions,
): ShipMetricsCatalogPageData {
  const [catalogPage, setCatalogPage] = useState<ShipMetricCatalogPage | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [lastSyncResult, setLastSyncResult] =
    useState<ShipMetricsSyncResult | null>(null);

  const refreshCatalog = useCallback(async () => {
    if (!options.enabled || !token || !shipId) {
      setCatalogPage(null);
      setLoading(false);
      return;
    }

    setLoading(true);

    try {
      const nextCatalogPage = await getShipMetricsCatalogPage(shipId, token, {
        search: options.search,
        bucket: options.bucket,
        page: options.page,
        pageSize: options.pageSize,
      });

      setCatalogPage(nextCatalogPage);
    } catch (catalogError) {
      setError(
        catalogError instanceof Error
          ? catalogError.message
          : "Failed to load ship metrics",
      );
    } finally {
      setLoading(false);
    }
  }, [
    options.bucket,
    options.enabled,
    options.page,
    options.pageSize,
    options.search,
    shipId,
    token,
  ]);

  const syncCatalog = useCallback(
    async (syncOptions: SyncShipMetricsOptions = {}) => {
      if (!options.enabled || !token || !shipId) {
        return;
      }

      setSyncing(true);

      if (!syncOptions.silent) {
        setError("");
      }

      try {
        const result = await syncShipMetricsCatalog(shipId, token);
        setLastSyncResult(result);

        const nextCatalogPage = await getShipMetricsCatalogPage(shipId, token, {
          search: options.search,
          bucket: options.bucket,
          page: options.page,
          pageSize: options.pageSize,
        });

        setCatalogPage(nextCatalogPage);
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
    [
      options.bucket,
      options.enabled,
      options.page,
      options.pageSize,
      options.search,
      shipId,
      token,
    ],
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

        setCatalogPage((currentCatalogPage) => {
          if (!currentCatalogPage) {
            return currentCatalogPage;
          }

          return {
            ...currentCatalogPage,
            items: currentCatalogPage.items.map((metric) =>
              metric.id === updatedMetric.id ? updatedMetric : metric,
            ),
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
    if (!options.enabled || !token || !shipId) {
      setCatalogPage(null);
      setLastSyncResult(null);
      setLoading(false);
      setSyncing(false);
      setError("");
      return;
    }

    setError("");
    void refreshCatalog();
  }, [options.enabled, refreshCatalog, shipId, token]);

  useEffect(() => {
    setLastSyncResult(null);
  }, [shipId]);

  return {
    catalogPage,
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
