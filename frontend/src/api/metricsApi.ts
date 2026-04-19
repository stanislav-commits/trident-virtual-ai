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
  descriptionsQueued?: number;
  staleMetricsRemoved: number;
  syncedAt: string;
  semanticBootstrap?: {
    totalMetrics: number;
    conceptsCreated: number;
    conceptsUpdated: number;
    aliasesAdded: number;
    membersAdded: number;
    skippedBindings: number;
  } | null;
}

export interface MetricConceptBootstrapResult {
  ship: {
    id: string;
    name: string;
    organizationName: string | null;
  };
  totalMetrics: number;
  conceptsCreated: number;
  conceptsUpdated: number;
  aliasesAdded: number;
  membersAdded: number;
  skippedBindings: number;
  sampleConcepts: Array<{
    slug: string;
    displayName: string;
    aliases: string[];
  }>;
}

export type MetricConceptType =
  | "single"
  | "group"
  | "composite"
  | "paired"
  | "comparison"
  | "trajectory";

export type MetricAggregationRule =
  | "none"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "last"
  | "coordinate_pair"
  | "compare"
  | "trajectory";

export type MetricQueryTimeMode = "snapshot" | "point_in_time" | "range";

export interface MetricConceptMember {
  id: string;
  role: string | null;
  sortOrder: number;
  metricCatalogId: string | null;
  childConceptId: string | null;
  metric: {
    id: string;
    shipId: string;
    key: string;
    bucket: string;
    field: string;
    description: string | null;
  } | null;
  childConcept: {
    id: string;
    slug: string;
    displayName: string;
  } | null;
}

export interface MetricConcept {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  category: string | null;
  type: MetricConceptType;
  aggregationRule: MetricAggregationRule;
  unit: string | null;
  isActive: boolean;
  aliases: string[];
  members: MetricConceptMember[];
  createdAt: string;
  updatedAt: string;
}

export interface MetricConceptResolutionCandidate {
  concept: MetricConcept;
  score: number;
  matchReason: string;
}

export interface MetricConceptResolutionResult {
  query: string;
  normalizedQuery: string;
  resolvedConcept: MetricConcept | null;
  candidates: MetricConceptResolutionCandidate[];
}

export interface MetricConceptMemberInput {
  metricCatalogId?: string;
  childConceptId?: string;
  role?: string;
  sortOrder?: number;
}

export interface SaveMetricConceptInput {
  slug: string;
  displayName: string;
  description?: string | null;
  category?: string | null;
  type: MetricConceptType;
  aggregationRule?: MetricAggregationRule;
  unit?: string | null;
  isActive?: boolean;
  aliases?: string[];
  members?: MetricConceptMemberInput[];
}

export interface MetricConceptExecutionResponse {
  query: string | null;
  ship: {
    id: string;
    name: string;
    organizationName: string | null;
  };
  concept: {
    id: string;
    slug: string;
    displayName: string;
    description: string | null;
    category: string | null;
    type: MetricConceptType;
    aggregationRule: MetricAggregationRule;
    unit: string | null;
  };
  timeMode: MetricQueryTimeMode;
  timestamp: string | null;
  queriedMetricCount: number;
  result: {
    conceptId: string;
    conceptSlug: string;
    conceptDisplayName: string;
    type: MetricConceptType;
    aggregationRule: MetricAggregationRule;
    value: unknown;
    unit: string | null;
    timestamp: string | null;
    members: Array<{
      memberId: string;
      role: string | null;
      sourceType: "metric" | "concept";
      metricCatalogId: string | null;
      childConceptId: string | null;
      label: string;
      key: string | null;
      value: unknown;
      unit: string | null;
      timestamp: string | null;
      description: string | null;
      result: MetricConceptExecutionResponse["result"] | null;
    }>;
    metadata: Record<string, unknown> | null;
  };
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

export async function bootstrapShipMetricConcepts(
  shipId: string,
  token: string,
): Promise<MetricConceptBootstrapResult> {
  const response = await fetchWithAuth(
    `metrics/ships/${shipId}/bootstrap-semantic-concepts`,
    {
      token,
      method: "POST",
    },
  );

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to bootstrap semantic concepts");
  }

  return response.json();
}

export async function listMetricConcepts(
  token: string,
  shipId?: string | null,
): Promise<MetricConcept[]> {
  const suffix = shipId ? `?shipId=${encodeURIComponent(shipId)}` : "";
  const response = await fetchWithAuth(`metrics/concepts${suffix}`, {
    token,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to load metric concepts");
  }

  return response.json();
}

export async function createMetricConcept(
  input: SaveMetricConceptInput,
  token: string,
): Promise<MetricConcept> {
  const response = await fetchWithAuth("metrics/concepts", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to create metric concept");
  }

  return response.json();
}

export async function updateMetricConcept(
  conceptId: string,
  input: Partial<SaveMetricConceptInput>,
  token: string,
): Promise<MetricConcept> {
  const response = await fetchWithAuth(`metrics/concepts/${conceptId}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to update metric concept");
  }

  return response.json();
}

export async function resolveMetricConcept(
  query: string,
  token: string,
  shipId?: string | null,
): Promise<MetricConceptResolutionResult> {
  const response = await fetchWithAuth("metrics/concepts/resolve", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      shipId: shipId ?? undefined,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to resolve metric concept");
  }

  return response.json();
}

export async function executeMetricConcept(
  token: string,
  input: {
    conceptId?: string;
    query?: string;
    shipId?: string | null;
    timeMode?: MetricQueryTimeMode;
    timestamp?: string | null;
  },
): Promise<MetricConceptExecutionResponse> {
  const response = await fetchWithAuth("metrics/concepts/execute", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...input,
      shipId: input.shipId ?? undefined,
      timestamp: input.timestamp ?? undefined,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to execute metric concept");
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
