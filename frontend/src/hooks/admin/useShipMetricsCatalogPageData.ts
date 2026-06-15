import { useCallback, useEffect, useState } from "react";
import {
  analyzeShipMetrics,
  getShipMetricsAnalyzeProgress,
  getShipMetricsCatalogPage,
  syncShipMetricsCatalog,
  toggleShipMetrics,
  updateShipMetricDescription,
  type MetricBoundFilter,
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
  bound: MetricBoundFilter;
  page: number;
  pageSize: number;
  enabled: boolean;
}

export interface ShipMetricsCatalogPageData {
  catalogPage: ShipMetricCatalogPage | null;
  loading: boolean;
  syncing: boolean;
  toggling: boolean;
  error: string;
  setError: (nextError: string) => void;
  refreshCatalog: () => Promise<void>;
  syncCatalog: (options?: SyncShipMetricsOptions) => Promise<void>;
  updateDescription: (
    metricId: string,
    description: string | null,
  ) => Promise<ShipMetricCatalogItem | null>;
  toggleMetrics: (
    isEnabled: boolean,
    metricIds?: string[],
  ) => Promise<void>;
  analyzing: boolean;
  analyzeProgress: { done: number; total: number } | null;
  analyzeCatalog: () => Promise<void>;
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
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState("");
  const [lastSyncResult, setLastSyncResult] =
    useState<ShipMetricsSyncResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

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
        bound: options.bound,
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
    options.bound,
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

  const analyzeCatalog = useCallback(async () => {
    if (!token || !shipId) {
      return;
    }
    setAnalyzing(true);
    setAnalyzeProgress(null);
    setError("");
    try {
      const start = await analyzeShipMetrics(shipId, token);
      setAnalyzeProgress({ done: 0, total: start.totalQueued });
      // Poll progress until the background run drains the queue.
      await new Promise<void>((resolve) => {
        const poll = async () => {
          try {
            const p = await getShipMetricsAnalyzeProgress(shipId, token);
            if (p.progress) {
              setAnalyzeProgress({
                done: p.progress.done,
                total: p.progress.total,
              });
              if (p.progress.done >= p.progress.total) {
                resolve();
                return;
              }
            } else {
              resolve();
              return;
            }
          } catch {
            resolve();
            return;
          }
          setTimeout(() => void poll(), 3000);
        };
        setTimeout(() => void poll(), 3000);
      });
      await refreshCatalog();
    } catch (analyzeError) {
      setError(
        analyzeError instanceof Error
          ? analyzeError.message
          : "Failed to analyze ship metrics",
      );
    } finally {
      setAnalyzing(false);
      setAnalyzeProgress(null);
    }
  }, [refreshCatalog, shipId, token]);

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

  const toggleMetrics = useCallback(
    async (isEnabled: boolean, metricIds?: string[]) => {
      if (!token || !shipId) {
        return;
      }

      setToggling(true);

      try {
        await toggleShipMetrics(shipId, token, {
          isEnabled,
          metricIds: metricIds?.length ? metricIds : undefined,
        });

        setCatalogPage((currentCatalogPage) => {
          if (!currentCatalogPage) {
            return currentCatalogPage;
          }

          const idsToUpdate = metricIds?.length
            ? new Set(metricIds)
            : null;

          return {
            ...currentCatalogPage,
            items: currentCatalogPage.items.map((metric) =>
              idsToUpdate === null || idsToUpdate.has(metric.id)
                ? { ...metric, isEnabled }
                : metric,
            ),
          };
        });
      } catch (toggleError) {
        setError(
          toggleError instanceof Error
            ? toggleError.message
            : "Failed to toggle metrics",
        );
      } finally {
        setToggling(false);
      }
    },
    [shipId, token],
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
    toggling,
    error,
    setError,
    refreshCatalog,
    syncCatalog,
    updateDescription,
    toggleMetrics,
    analyzing,
    analyzeProgress,
    analyzeCatalog,
    lastSyncResult,
  };
}
