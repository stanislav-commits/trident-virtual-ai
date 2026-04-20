import { useCallback, useEffect, useRef, useState } from "react";
import {
  bootstrapShipMetricConcepts,
  createMetricConcept,
  executeMetricConcept,
  listMetricConceptsPage,
  type MetricConceptBootstrapResult,
  resolveMetricConcept,
  type MetricConcept,
  type MetricConceptExecutionResponse,
  type MetricConceptResolutionResult,
  type SaveMetricConceptInput,
  updateMetricConcept,
} from "../../api/metricsApi";

const METRIC_CONCEPTS_PAGE_SIZE = 50;

export interface MetricConceptsAdminData {
  concepts: MetricConcept[];
  totalConcepts: number;
  loading: boolean;
  loadingMore: boolean;
  saving: boolean;
  bootstrapping: boolean;
  hasMore: boolean;
  error: string;
  setError: (nextError: string) => void;
  refreshConcepts: () => Promise<void>;
  loadMoreConcepts: () => Promise<void>;
  bootstrapConcepts: () => Promise<MetricConceptBootstrapResult | null>;
  saveConcept: (
    conceptId: string | null,
    input: SaveMetricConceptInput,
  ) => Promise<MetricConcept | null>;
  resolveQuery: (
    query: string,
  ) => Promise<MetricConceptResolutionResult | null>;
  executeConcept: (input: {
    conceptId?: string;
    query?: string;
    timeMode?: "snapshot" | "point_in_time";
    timestamp?: string | null;
  }) => Promise<MetricConceptExecutionResponse | null>;
}

export function useMetricConceptsAdminData(
  token: string | null,
  shipId: string | null,
  search: string,
  enabled: boolean,
): MetricConceptsAdminData {
  const [concepts, setConcepts] = useState<MetricConcept[]>([]);
  const [totalConcepts, setTotalConcepts] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const latestRequestIdRef = useRef(0);

  const fetchConceptPage = useCallback(
    async (nextPage: number, mode: "replace" | "append") => {
      if (!enabled || !token || !shipId) {
        setConcepts([]);
        setTotalConcepts(0);
        setPage(1);
        setHasMore(false);
        setLoading(false);
        setLoadingMore(false);
        return null;
      }

      const requestId = latestRequestIdRef.current + 1;
      latestRequestIdRef.current = requestId;

      if (mode === "append") {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }

      try {
        const nextConceptPage = await listMetricConceptsPage(token, {
          shipId,
          search,
          page: nextPage,
          pageSize: METRIC_CONCEPTS_PAGE_SIZE,
        });

        if (latestRequestIdRef.current !== requestId) {
          return nextConceptPage;
        }

        setConcepts((current) =>
          mode === "append"
            ? [...current, ...nextConceptPage.items]
            : nextConceptPage.items,
        );
        setTotalConcepts(nextConceptPage.totalConcepts);
        setPage(nextConceptPage.page);
        setHasMore(nextConceptPage.hasMore);
        return nextConceptPage;
      } catch (conceptError) {
        if (latestRequestIdRef.current === requestId) {
          setError(
            conceptError instanceof Error
              ? conceptError.message
              : "Failed to load metric concepts",
          );
        }
        return null;
      } finally {
        if (latestRequestIdRef.current === requestId) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [enabled, search, shipId, token],
  );

  const refreshConcepts = useCallback(async () => {
    if (!enabled || !token || !shipId) {
      setConcepts([]);
      setTotalConcepts(0);
      setPage(1);
      setHasMore(false);
      setLoading(false);
      return;
    }

    setError("");
    await fetchConceptPage(1, "replace");
  }, [enabled, fetchConceptPage, shipId, token]);

  const loadMoreConcepts = useCallback(async () => {
    if (!enabled || !token || !shipId || loading || loadingMore || !hasMore) {
      return;
    }

    await fetchConceptPage(page + 1, "append");
  }, [
    enabled,
    fetchConceptPage,
    hasMore,
    loading,
    loadingMore,
    page,
    shipId,
    token,
  ]);

  const bootstrapConcepts = useCallback(async () => {
    if (!enabled || !token || !shipId) {
      return null;
    }

    setBootstrapping(true);
    setError("");

    try {
      const result = await bootstrapShipMetricConcepts(shipId, token);
      await refreshConcepts();
      return result;
    } catch (bootstrapError) {
      setError(
        bootstrapError instanceof Error
          ? bootstrapError.message
          : "Failed to bootstrap semantic concepts",
      );
      return null;
    } finally {
      setBootstrapping(false);
    }
  }, [enabled, refreshConcepts, shipId, token]);

  const saveConcept = useCallback(
    async (conceptId: string | null, input: SaveMetricConceptInput) => {
      if (!enabled || !token) {
        return null;
      }

      setSaving(true);
      setError("");

      try {
        const savedConcept = conceptId
          ? await updateMetricConcept(conceptId, input, token)
          : await createMetricConcept(input, token);
        await refreshConcepts();

        return savedConcept;
      } catch (saveError) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Failed to save metric concept",
        );
        return null;
      } finally {
        setSaving(false);
      }
    },
    [enabled, refreshConcepts, token],
  );

  const resolveQuery = useCallback(
    async (query: string) => {
      if (!enabled || !token || !shipId) {
        return null;
      }

      try {
        return await resolveMetricConcept(query, token, shipId);
      } catch (resolveError) {
        const message =
          resolveError instanceof Error
            ? resolveError.message
            : "Failed to resolve metric concept";
        setError(message);
        throw new Error(message);
      }
    },
    [enabled, shipId, token],
  );

  const executeConceptRequest = useCallback(
    async (input: {
      conceptId?: string;
      query?: string;
      timeMode?: "snapshot" | "point_in_time";
      timestamp?: string | null;
    }) => {
      if (!enabled || !token || !shipId) {
        return null;
      }

      try {
        return await executeMetricConcept(token, {
          ...input,
          shipId,
        });
      } catch (executeError) {
        const message =
          executeError instanceof Error
            ? executeError.message
            : "Failed to execute metric concept";
        setError(message);
        throw new Error(message);
      }
    },
    [enabled, shipId, token],
  );

  useEffect(() => {
    if (!enabled || !token || !shipId) {
      setConcepts([]);
      setTotalConcepts(0);
      setPage(1);
      setLoading(false);
      setLoadingMore(false);
      setSaving(false);
      setBootstrapping(false);
      setHasMore(false);
      setError("");
      return;
    }

    setError("");
    void refreshConcepts();
  }, [enabled, refreshConcepts, search, shipId, token]);

  return {
    concepts,
    totalConcepts,
    loading,
    loadingMore,
    saving,
    bootstrapping,
    hasMore,
    error,
    setError,
    refreshConcepts,
    loadMoreConcepts,
    bootstrapConcepts,
    saveConcept,
    resolveQuery,
    executeConcept: executeConceptRequest,
  };
}
