import { fetchWithAuth } from "./core";
import type { ShipSummaryItem } from "./shipsApi";

export { getApiUrl, fetchWithAuth } from "./core";
export { login } from "./authApi";
export type { UserListItem } from "./usersApi";
export {
  createUser,
  deleteUser,
  getUsers,
  resetPassword,
  updateUserName,
} from "./usersApi";
export type {
  CreateShipInput,
  ShipSummaryItem,
  UpdateShipInput,
} from "./shipsApi";
export {
  createShip,
  deleteShip,
  getOrganizations,
  getShip,
  getShips,
  updateShip,
} from "./shipsApi";

// Legacy compatibility layer for admin areas that have not been migrated yet.

export type SystemPromptPlaceholder = {
  token: string;
  description: string;
};

export type TagListItem = {
  id: string;
  key: string;
  category: string;
  subcategory: string;
  item: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  metricLinksCount: number;
  manualLinksCount: number;
};

export type TagOption = {
  id: string;
  key: string;
  category: string;
  subcategory: string;
  item: string;
  description: string | null;
};

export type TagImportResult = {
  sourceEntries: number;
  uniqueTags: number;
  created: number;
  updated: number;
  warnings: string[];
  warningCount: number;
};

export type RebuildTagLinksResult = {
  scope: "all" | "metrics" | "manuals";
  replaceExisting: boolean;
  metrics: {
    processed: number;
    linked: number;
    untouched: number;
    cleared: number;
  };
  manuals: {
    processed: number;
    linked: number;
    untouched: number;
    cleared: number;
  };
};

export type TagListFiltersMeta = {
  categoryOptions: string[];
  subcategoryOptions: string[];
};

export type TagListSummary = {
  totalTags: number;
  filteredTags: number;
  categories: number;
  metricLinks: number;
  manualLinks: number;
};

export type TagListResult = PaginatedListResult<TagListItem> & {
  filters: TagListFiltersMeta;
  summary: TagListSummary;
};

export type SystemPromptConfig = {
  prompt: string;
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: {
    id: string;
    userId: string;
    name: string | null;
  } | null;
  placeholders: SystemPromptPlaceholder[];
};

export async function getSystemPrompt(
  token: string,
): Promise<SystemPromptConfig> {
  const res = await fetchWithAuth("system-prompt", { token });
  if (!res.ok) throw new Error("Failed to fetch system prompt");
  return res.json();
}

export async function updateSystemPrompt(
  prompt: string,
  token: string,
): Promise<SystemPromptConfig> {
  const res = await fetchWithAuth("system-prompt", {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to update system prompt");
  }
  return res.json();
}

export async function getTags(
  token: string,
  params?: {
    page?: number;
    pageSize?: number;
    search?: string;
    category?: string;
    subcategory?: string;
  },
): Promise<TagListResult> {
  const res = await fetchWithAuth(withTagsQuery("tags", params), { token });
  if (!res.ok) throw new Error("Failed to fetch tags");
  return res.json();
}

export async function getTagOptions(token: string): Promise<TagOption[]> {
  const res = await fetchWithAuth("tags/options", { token });
  if (!res.ok) throw new Error("Failed to fetch tag options");
  return res.json();
}

export async function createTag(
  body: {
    category: string;
    subcategory?: string;
    item: string;
    description?: string | null;
  },
  token: string,
): Promise<TagListItem> {
  const res = await fetchWithAuth("tags", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to create tag");
  }
  return res.json();
}

export async function updateTag(
  id: string,
  body: {
    category?: string;
    subcategory?: string;
    item?: string;
    description?: string | null;
  },
  token: string,
): Promise<TagListItem> {
  const res = await fetchWithAuth(`tags/${id}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to update tag");
  }
  return res.json();
}

export async function deleteTag(id: string, token: string): Promise<void> {
  const res = await fetchWithAuth(`tags/${id}`, {
    token,
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to delete tag");
  }
}

export type BulkDeleteTagsBody =
  | {
      mode: "tagIds";
      tagIds: string[];
      category?: string;
      subcategory?: string;
      search?: string;
    }
  | {
      mode: "all";
      excludeTagIds?: string[];
      category?: string;
      subcategory?: string;
      search?: string;
    };

export async function bulkDeleteTags(
  body: BulkDeleteTagsBody,
  token: string,
): Promise<{ deletedCount: number }> {
  const res = await fetchWithAuth("tags/bulk-delete", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to delete selected tags");
  }
  return res.json();
}

export async function importTags(
  file: File,
  token: string,
): Promise<TagImportResult> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetchWithAuth("tags/import", {
    token,
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to import tags");
  }
  return res.json();
}

export async function rebuildTagLinks(
  token: string,
  body?: {
    scope?: "all" | "metrics" | "manuals";
    shipId?: string;
    replaceExisting?: boolean;
  },
): Promise<RebuildTagLinksResult> {
  const res = await fetchWithAuth("tags/rebuild-links", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to rebuild tag links");
  }
  return res.json();
}


export type MetricDefinitionItem = {
  key: string;
  label: string;
  description: string | null;
  unit: string | null;
  dataType: string;
  bucket?: string | null;
  measurement?: string | null;
  field?: string | null;
  status?: string | null;
  createdAt?: string;
};

export type ShipMetricsConfigItem = {
  metricKey: string;
  isActive: boolean;
  metric?: { key: string; label: string; unit: string | null };
};

export type ShipAssignedUserItem = {
  id: string;
  userId: string;
  name?: string | null;
};

export type ShipManualItem = {
  id: string;
  ragflowDocumentId: string;
  filename: string;
  category: ShipManualCategory;
  uploadedAt: string;
};

export type ShipManualCategory =
  | "MANUALS"
  | "HISTORY_PROCEDURES"
  | "CERTIFICATES"
  | "REGULATION";

export type PaginationMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

export type PaginatedListResult<T> = {
  items: T[];
  pagination: PaginationMeta;
};

export type ManualStatusItem = ShipManualItem & {
  run: string | null;
  progress: number | null;
  progressMsg: string | null;
  chunkCount: number | null;
};

type PaginationParams = {
  page?: number;
  pageSize?: number;
};

type ManualPaginationParams = PaginationParams & {
  category?: ShipManualCategory;
  search?: string;
};

function withPaginationQuery(
  path: string,
  params?: ManualPaginationParams,
): string {
  if (
    !params?.page &&
    !params?.pageSize &&
    !params?.category &&
    !params?.search?.trim()
  ) {
    return path;
  }

  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));
  if (params.category) query.set("category", params.category);
  if (params.search?.trim()) query.set("search", params.search.trim());
  return `${path}?${query.toString()}`;
}

function withTagsQuery(
  path: string,
  params?: {
    page?: number;
    pageSize?: number;
    search?: string;
    category?: string;
    subcategory?: string;
  },
): string {
  const query = new URLSearchParams();
  if (params?.page) query.set("page", String(params.page));
  if (params?.pageSize) query.set("pageSize", String(params.pageSize));
  if (params?.search?.trim()) query.set("search", params.search.trim());
  if (params?.category?.trim()) query.set("category", params.category.trim());
  if (params?.subcategory?.trim()) {
    query.set("subcategory", params.subcategory.trim());
  }

  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

// Legacy ship shape for metrics/manuals management.
// The ship registry flow should consume ShipSummaryItem from shipsApi instead.
export type ShipListItem = ShipSummaryItem & {
  flag?: string | null;
  lengthOverall?: number | null;
  beam?: number | null;
  deadweight?: number | null;
  grossTonnage?: number | null;
  buildYard?: string | null;
  shipClass?: string | null;
  metricsSyncStatus?: string;
  metricsSyncError?: string | null;
  metricsSyncedAt?: string | null;
  lastTelemetry?: Record<string, unknown>;
  metricsConfig?: ShipMetricsConfigItem[];
  assignedUsers?: ShipAssignedUserItem[];
  ragflowDatasetId?: string | null;
  manuals?: ShipManualItem[];
};

export async function getMetricDefinitions(
  token: string,
): Promise<MetricDefinitionItem[]> {
  const res = await fetchWithAuth("ships/metric-definitions", { token });
  if (!res.ok) throw new Error("Failed to fetch metric definitions");
  return res.json();
}

export async function getMetrics(
  token: string,
): Promise<MetricDefinitionItem[]> {
  const res = await fetchWithAuth("metrics", { token });
  if (!res.ok) throw new Error("Failed to fetch metrics");
  return res.json();
}

export type CreateMetricBody = {
  key: string;
  label: string;
  description?: string;
  unit?: string;
  dataType?: string;
};

export async function createMetric(
  body: CreateMetricBody,
  token: string,
): Promise<MetricDefinitionItem> {
  const res = await fetchWithAuth("metrics", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to create metric");
  }
  return res.json();
}

export type UpdateMetricBody = {
  label?: string;
  description?: string;
  unit?: string;
  dataType?: string;
};

export async function updateMetric(
  key: string,
  body: UpdateMetricBody,
  token: string,
): Promise<MetricDefinitionItem> {
  const res = await fetchWithAuth(`metrics/${encodeURIComponent(key)}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to update metric");
  }
  return res.json();
}

export async function getMetricTags(
  key: string,
  token: string,
): Promise<TagOption[]> {
  const res = await fetchWithAuth(`metrics/${encodeURIComponent(key)}/tags`, {
    token,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to fetch metric tags");
  }
  return res.json();
}

export async function replaceMetricTags(
  key: string,
  tagIds: string[],
  token: string,
): Promise<TagOption[]> {
  const res = await fetchWithAuth(`metrics/${encodeURIComponent(key)}/tags`, {
    token,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tagIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to update metric tags");
  }
  return res.json();
}

export async function deleteMetric(key: string, token: string): Promise<void> {
  const res = await fetchWithAuth(`metrics/${encodeURIComponent(key)}`, {
    token,
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to delete metric");
  }
}

export async function updateShipMetricActivity(
  _id: string,
  _metricKeys: string[],
  _token: string,
): Promise<ShipListItem> {
  throw new Error(
    "Ship metric activity is being rebuilt separately from the ship registry flow.",
  );
}

export async function uploadManual(
  shipId: string,
  file: File,
  token: string,
  category?: ShipManualCategory,
): Promise<ShipManualItem | ShipManualItem[]> {
  const form = new FormData();
  form.append("file", file);
  if (category) form.append("category", category);
  const res = await fetchWithAuth(`ships/${shipId}/manuals`, {
    token,
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to upload manual");
  }
  return res.json();
}

export async function getManuals(
  shipId: string,
  token: string,
  params?: ManualPaginationParams,
): Promise<PaginatedListResult<ShipManualItem>> {
  const res = await fetchWithAuth(
    withPaginationQuery(`ships/${shipId}/manuals`, params),
    {
      token,
    },
  );
  if (!res.ok) throw new Error("Failed to fetch manuals");
  return res.json();
}

export async function getManualsStatus(
  shipId: string,
  token: string,
  params?: ManualPaginationParams,
): Promise<PaginatedListResult<ManualStatusItem>> {
  const res = await fetchWithAuth(
    withPaginationQuery(`ships/${shipId}/manuals/status`, params),
    { token },
  );
  if (!res.ok) throw new Error("Failed to fetch manuals status");
  return res.json();
}

export async function deleteManual(
  shipId: string,
  manualId: string,
  token: string,
): Promise<void> {
  const res = await fetchWithAuth(`ships/${shipId}/manuals/${manualId}`, {
    token,
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to delete manual");
  }
}

export type BulkDeleteManualsBody =
  | {
      mode: "manualIds";
      manualIds: string[];
      category?: ShipManualCategory;
      search?: string;
    }
  | {
      mode: "all";
      excludeManualIds?: string[];
      category?: ShipManualCategory;
      search?: string;
    };

export async function bulkDeleteManuals(
  shipId: string,
  body: BulkDeleteManualsBody,
  token: string,
): Promise<{ deletedCount: number }> {
  const res = await fetchWithAuth(`ships/${shipId}/manuals/bulk-delete`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to delete selected manuals");
  }
  return res.json();
}

export async function updateManual(
  shipId: string,
  manualId: string,
  body: { filename?: string; category?: ShipManualCategory },
  token: string,
): Promise<ShipManualItem> {
  const res = await fetchWithAuth(`ships/${shipId}/manuals/${manualId}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to update manual");
  }
  return res.json();
}

export async function getManualTags(
  shipId: string,
  manualId: string,
  token: string,
): Promise<TagOption[]> {
  const res = await fetchWithAuth(`ships/${shipId}/manuals/${manualId}/tags`, {
    token,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to fetch manual tags");
  }
  return res.json();
}

export async function replaceManualTags(
  shipId: string,
  manualId: string,
  tagIds: string[],
  token: string,
): Promise<TagOption[]> {
  const res = await fetchWithAuth(`ships/${shipId}/manuals/${manualId}/tags`, {
    token,
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tagIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to update manual tags");
  }
  return res.json();
}
