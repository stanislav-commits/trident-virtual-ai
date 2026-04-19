import { useCallback, useEffect, useState } from "react";
import {
  bootstrapShipMetricConcepts,
  createMetricConcept,
  executeMetricConcept,
  listMetricConcepts,
  type MetricConceptBootstrapResult,
  resolveMetricConcept,
  type MetricConcept,
  type MetricConceptExecutionResponse,
  type MetricConceptResolutionResult,
  type SaveMetricConceptInput,
  updateMetricConcept,
} from "../../api/metricsApi";

export interface MetricConceptsAdminData {
  concepts: MetricConcept[];
  loading: boolean;
  saving: boolean;
  bootstrapping: boolean;
  error: string;
  setError: (nextError: string) => void;
  refreshConcepts: () => Promise<void>;
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
  enabled: boolean,
): MetricConceptsAdminData {
  const [concepts, setConcepts] = useState<MetricConcept[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [error, setError] = useState("");

  const refreshConcepts = useCallback(async () => {
    if (!enabled || !token || !shipId) {
      setConcepts([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    try {
      const nextConcepts = await listMetricConcepts(token, shipId);
      setConcepts(nextConcepts);
    } catch (conceptError) {
      setError(
        conceptError instanceof Error
          ? conceptError.message
          : "Failed to load metric concepts",
      );
    } finally {
      setLoading(false);
    }
  }, [enabled, shipId, token]);

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

        setConcepts((current) => {
          const next = current.filter((concept) => concept.id !== savedConcept.id);
          next.push(savedConcept);
          next.sort((left, right) => left.displayName.localeCompare(right.displayName));
          return next;
        });

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
    [enabled, token],
  );

  const resolveQuery = useCallback(
    async (query: string) => {
      if (!enabled || !token || !shipId) {
        return null;
      }

      try {
        return await resolveMetricConcept(query, token, shipId);
      } catch (resolveError) {
        setError(
          resolveError instanceof Error
            ? resolveError.message
            : "Failed to resolve metric concept",
        );
        return null;
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
        setError(
          executeError instanceof Error
            ? executeError.message
            : "Failed to execute metric concept",
        );
        return null;
      }
    },
    [enabled, shipId, token],
  );

  useEffect(() => {
    if (!enabled || !token || !shipId) {
      setConcepts([]);
      setLoading(false);
      setSaving(false);
      setBootstrapping(false);
      setError("");
      return;
    }

    setError("");
    void refreshConcepts();
  }, [enabled, refreshConcepts, shipId, token]);

  return {
    concepts,
    loading,
    saving,
    bootstrapping,
    error,
    setError,
    refreshConcepts,
    bootstrapConcepts,
    saveConcept,
    resolveQuery,
    executeConcept: executeConceptRequest,
  };
}
