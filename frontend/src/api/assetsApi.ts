import { fetchWithAuth } from "./core";

export type AssetItem = {
  id: string;
  shipId: string;
  assetIdInternal: string;
  displayName: string;
  sfiGroup: string | null;
  sfiGroupName: string | null;
  sfiSub: string | null;
  sfiSubName: string | null;
  drawingCode: string | null;
  parentAssetId: string | null;
  servedByAssetId: string | null;
  locationAssetId: string | null;
  brand: string | null;
  model: string | null;
  serialNo: string | null;
  criticality: number | null;
  commissionedDate: string | null;
  location: string | null;
  rinaRef: string | null;
  notes: string | null;
  // v14.6 universal location schema
  zone: string | null;
  deckRole: string | null;
  deckLevel: number | null;
  spaceInstance: string | null;
  spaceLabel: string | null;
  // Maintenance
  drawingRef: string | null;
  inspectionObligation: string | null;
  // Provenance
  parentAutoPopulated: boolean | null;
  criticalityAutoPopulated: boolean | null;
  sourceSheet: string | null;
  // Non-canonical overflow
  extras: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type ListAssetsResponse = {
  items: AssetItem[];
  total: number;
  limit: number;
  offset: number;
};

export type AssetListQuery = {
  search?: string;
  sfiGroup?: string;
  sfiSub?: string;
  assetIdPrefix?: string;
  limit?: number;
  offset?: number;
};

export type RelatedAssetMetric = {
  id: string;
  key: string;
  bucket: string;
  measurement: string;
  field: string;
  aiDescription: string | null;
  aiKind: string | null;
  aiUnit: string | null;
  aiBoundConfidence: number | null;
  aiGeneratedAt: string | null;
};

export type RelatedAssetDocument = {
  id: string;
  originalFileName: string;
  manufacturer: string | null;
  model: string | null;
  equipmentName: string | null;
  docClass: string;
  parseStatus: string;
  createdAt: string;
  linkSource: "explicit" | "auto";
};

export type RelatedAssetResult = {
  asset: AssetItem;
  metrics: RelatedAssetMetric[];
  documents: RelatedAssetDocument[];
  /** Vessel plans/drawings: explicit links + drawing-code filename matches. */
  drawings: RelatedAssetDocument[];
};

export type AssetImportResult = {
  totalRows: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; sfiCode?: string; reason: string }>;
};

function buildQueryString(query: AssetListQuery): string {
  const params = new URLSearchParams();
  if (query.search) params.append("search", query.search);
  if (query.sfiGroup) params.append("sfiGroup", query.sfiGroup);
  if (query.sfiSub) params.append("sfiSub", query.sfiSub);
  if (query.assetIdPrefix) params.append("assetIdPrefix", query.assetIdPrefix);
  if (query.limit !== undefined) params.append("limit", String(query.limit));
  if (query.offset !== undefined) params.append("offset", String(query.offset));
  const s = params.toString();
  return s ? `?${s}` : "";
}

export async function listAssets(
  token: string,
  shipId: string,
  query: AssetListQuery = {},
): Promise<ListAssetsResponse> {
  const response = await fetchWithAuth(
    `ships/${shipId}/assets${buildQueryString(query)}`,
    { token },
  );
  if (!response.ok) {
    throw new Error(`Failed to load assets (${response.status})`);
  }
  return (await response.json()) as ListAssetsResponse;
}

export async function getRelatedAsset(
  token: string,
  shipId: string,
  assetId: string,
): Promise<RelatedAssetResult> {
  const response = await fetchWithAuth(
    `ships/${shipId}/assets/${assetId}/related`,
    { token },
  );
  if (!response.ok) {
    throw new Error(`Failed to load related data (${response.status})`);
  }
  return (await response.json()) as RelatedAssetResult;
}

export async function importAssetsXlsx(
  token: string,
  shipId: string,
  file: File,
): Promise<AssetImportResult> {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetchWithAuth(
    `ships/${shipId}/assets/import-xlsx`,
    { token, method: "POST", body: formData },
  );
  if (!response.ok) {
    const errMsg = await response.text();
    throw new Error(`Import failed (${response.status}): ${errMsg.slice(0, 300)}`);
  }
  return (await response.json()) as AssetImportResult;
}

export type ImportPreviewResult = {
  totalRows: number;
  parseErrors: Array<{ row: number; reason: string }>;
  create: Array<{
    assetIdInternal: string;
    displayName: string;
    sfiGroup: string | null;
    brand: string | null;
    model: string | null;
  }>;
  update: Array<{
    assetIdInternal: string;
    displayName: string;
    changes: Array<{ field: string; oldValue: string | null; newValue: string | null }>;
  }>;
  orphans: Array<{
    assetIdInternal: string;
    displayName: string;
    sfiGroup: string | null;
    brand: string | null;
    model: string | null;
    boundMetricCount: number;
    linkedDocumentCount: number;
  }>;
  potentialRenames: Array<{
    oldAssetIdInternal: string;
    newAssetIdInternal: string;
    displayName: string;
    matchScore: "exact-name-brand-model" | "exact-name-brand" | "exact-name";
  }>;
  sfiWarnings: Array<{
    assetIdInternal: string;
    sfiSub: string | null;
    reason: "unknown-code" | "missing";
  }>;
  counts: {
    create: number;
    update: number;
    orphans: number;
    renames: number;
    parseErrors: number;
    sfiWarnings: number;
  };
};

export async function previewImportAssetsXlsx(
  token: string,
  shipId: string,
  file: File,
): Promise<ImportPreviewResult> {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetchWithAuth(
    `ships/${shipId}/assets/import-xlsx/preview`,
    { token, method: "POST", body: formData },
  );
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Preview failed (${response.status}): ${txt.slice(0, 300)}`);
  }
  return (await response.json()) as ImportPreviewResult;
}

export type CommitImportOptions = {
  deleteOrphans: boolean;
  mergeRenames: boolean;
  snapshotBefore: boolean;
};

export type CommitImportResult = AssetImportResult & {
  snapshotId: string | null;
  deleted: number;
  merged: number;
};

export async function commitImportAssetsXlsx(
  token: string,
  shipId: string,
  file: File,
  opts: CommitImportOptions,
): Promise<CommitImportResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("deleteOrphans", String(opts.deleteOrphans));
  formData.append("mergeRenames", String(opts.mergeRenames));
  formData.append("snapshotBefore", String(opts.snapshotBefore));
  const response = await fetchWithAuth(
    `ships/${shipId}/assets/import-xlsx/commit`,
    { token, method: "POST", body: formData },
  );
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Commit failed (${response.status}): ${txt.slice(0, 300)}`);
  }
  return (await response.json()) as CommitImportResult;
}

export type UpdateAssetInput = Partial<{
  assetIdInternal: string;
  displayName: string;
  brand: string | null;
  model: string | null;
  serialNo: string | null;
  servedByAssetId: string | null;
  location: string | null;
  notes: string | null;
  criticality: number | null;
  sfiGroup: string | null;
  sfiGroupName: string | null;
  sfiSub: string | null;
  sfiSubName: string | null;
  drawingCode: string | null;
  commissionedDate: string | null;
  // v14.6
  zone: string | null;
  deckRole: string | null;
  spaceInstance: string | null;
  spaceLabel: string | null;
  drawingRef: string | null;
  inspectionObligation: string | null;
}>;

/**
 * Partial update of an asset. Used by inline-edit cells in the asset table —
 * each cell sends just the one field it owns.
 */
export async function updateAsset(
  token: string,
  shipId: string,
  assetId: string,
  patch: UpdateAssetInput,
): Promise<AssetItem> {
  const response = await fetchWithAuth(
    `ships/${shipId}/assets/${assetId}`,
    {
      token,
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Update failed (${response.status}): ${txt.slice(0, 200)}`);
  }
  return (await response.json()) as AssetItem;
}

/**
 * Pin a document to an asset (explicit human-curated link). The chat tools
 * combine these with brand/model fuzzy auto-matches. Idempotent on the
 * server side.
 */
export async function linkAssetDocument(
  token: string,
  shipId: string,
  assetId: string,
  documentId: string,
): Promise<void> {
  const response = await fetchWithAuth(
    `ships/${shipId}/assets/${assetId}/documents/${documentId}`,
    { token, method: "POST" },
  );
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Link failed (${response.status}): ${txt.slice(0, 200)}`);
  }
}

export async function unlinkAssetDocument(
  token: string,
  shipId: string,
  assetId: string,
  documentId: string,
): Promise<void> {
  const response = await fetchWithAuth(
    `ships/${shipId}/assets/${assetId}/documents/${documentId}`,
    { token, method: "DELETE" },
  );
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Unlink failed (${response.status}): ${txt.slice(0, 200)}`);
  }
}

export async function deleteAsset(
  token: string,
  shipId: string,
  assetId: string,
): Promise<void> {
  const response = await fetchWithAuth(
    `ships/${shipId}/assets/${assetId}`,
    { token, method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(`Delete failed (${response.status})`);
  }
}

export type CreateAssetInput = {
  assetIdInternal: string;
  displayName: string;
  sfiGroup?: string;
  sfiGroupName?: string;
  sfiSub?: string;
  sfiSubName?: string;
  brand?: string;
  model?: string;
  serialNo?: string;
  location?: string;
  criticality?: number;
  notes?: string;
};

/** Next free `<PREFIX>.<sub>.<NN>` id for the ship+sub (Add-asset autofill). */
export async function fetchNextAssetId(
  token: string,
  shipId: string,
  sfiSub: string,
): Promise<{ assetIdInternal: string | null; prefix: string | null }> {
  const response = await fetchWithAuth(
    `ships/${shipId}/assets/next-id?sfiSub=${encodeURIComponent(sfiSub)}`,
    { token },
  );
  if (!response.ok) return { assetIdInternal: null, prefix: null };
  return (await response.json()) as {
    assetIdInternal: string | null;
    prefix: string | null;
  };
}

/** Create a single asset on a ship. 409 if assetIdInternal already exists. */
export async function createAsset(
  token: string,
  shipId: string,
  input: CreateAssetInput,
): Promise<AssetItem> {
  const response = await fetchWithAuth(`ships/${shipId}/assets`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Create failed (${response.status}): ${txt.slice(0, 200)}`);
  }
  return (await response.json()) as AssetItem;
}

/**
 * Delete EVERY asset on a ship. The backend snapshots first (rollback
 * insurance) and returns the count removed + the snapshot id.
 */
export async function clearAllAssets(
  token: string,
  shipId: string,
): Promise<{ deleted: number; snapshotId: string | null }> {
  const response = await fetchWithAuth(`ships/${shipId}/assets`, {
    token,
    method: "DELETE",
  });
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Clear all failed (${response.status}): ${txt.slice(0, 200)}`);
  }
  return (await response.json()) as {
    deleted: number;
    snapshotId: string | null;
  };
}

/**
 * Download the whole register as an xlsx (canonical "Asset Register" sheet,
 * round-trips back through import). Returns the blob + server-suggested
 * filename so the caller can trigger a browser download.
 */
export async function exportAssetsXlsx(
  token: string,
  shipId: string,
): Promise<{ blob: Blob; filename: string }> {
  const response = await fetchWithAuth(`ships/${shipId}/assets/export-xlsx`, {
    token,
  });
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Export failed (${response.status}): ${txt.slice(0, 200)}`);
  }
  const cd = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([^";]+)"?/.exec(cd);
  const filename = match ? match[1] : "asset_register.xlsx";
  const blob = await response.blob();
  return { blob, filename };
}

/**
 * Manually override a metric's asset binding.
 *   boundAssetId=uuid  → bind to that asset (confidence stamped to 1.0)
 *   boundAssetId=null  → unbind (next analyze run can re-suggest)
 */
export async function updateMetricBinding(
  token: string,
  metricId: string,
  boundAssetId: string | null,
): Promise<void> {
  const response = await fetchWithAuth(`metrics/catalog/${metricId}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ boundAssetId }),
  });
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Update failed (${response.status}): ${txt.slice(0, 200)}`);
  }
}

/**
 * Human override of the AI-inferred unit on a metric. null clears the
 * override. Sets unit-confidence to 1.0 so re-analyze leaves it alone.
 */
export async function updateMetricUnit(
  token: string,
  metricId: string,
  aiUnit: string | null,
): Promise<void> {
  const response = await fetchWithAuth(`metrics/catalog/${metricId}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ aiUnit }),
  });
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(`Update failed (${response.status}): ${txt.slice(0, 200)}`);
  }
}

export type CatalogMetricListItem = {
  id: string;
  key: string;
  bucket: string;
  field: string;
  description: string | null;
  isEnabled: boolean;
  boundAssetId: string | null;
  aiBoundConfidence: number | null;
  aiKind: string | null;
  aiUnit: string | null;
  aiDescription: string | null;
  syncedAt: string;
};

export type CatalogPage = {
  ship: { id: string; name: string };
  totals: { metrics: number; enabled: number; disabled: number };
  buckets: Array<{ bucket: string; totalMetrics: number }>;
  items: CatalogMetricListItem[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
};

/**
 * Search the ship's metric catalog with paging — used by the asset-binding
 * picker. Returns metrics with their current boundAssetId so the UI can
 * show "already bound to other asset" badges.
 */
export async function searchShipMetrics(
  token: string,
  shipId: string,
  search: string,
  page: number = 1,
  pageSize: number = 50,
): Promise<CatalogPage> {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  if (search.trim()) params.append("search", search.trim());
  const response = await fetchWithAuth(
    `metrics/ships/${shipId}/catalog/items?${params.toString()}`,
    { token },
  );
  if (!response.ok) {
    throw new Error(`Failed to search metrics (${response.status})`);
  }
  return (await response.json()) as CatalogPage;
}

/** Service rule (PMS) attached to an asset — see backend service-rule.entity. */
export interface AssetServiceRule {
  id: string;
  taskName: string;
  intervalHours: number | null;
  intervalMonths: number | null;
  lastDoneAt: string | null;
  lastDoneRuntimeHours: number | null;
  source: string;
  notes: string | null;
}

export async function fetchAssetServiceRules(
  token: string,
  shipId: string,
  assetId: string,
): Promise<AssetServiceRule[]> {
  const response = await fetchWithAuth(
    `ships/${shipId}/assets/${assetId}/service-rules`,
    { token, method: "GET" },
  );
  if (!response.ok) {
    const txt = await response.text();
    throw new Error(
      `Service rules failed (${response.status}): ${txt.slice(0, 200)}`,
    );
  }
  return (await response.json()) as AssetServiceRule[];
}
