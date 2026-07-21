import { fetchWithAuth, getApiUrl } from "./core";

export type DocumentDocClass =
  | "procedure"
  | "manual"
  | "form"
  | "circular"
  | "plan"
  | "publication"
  | "historical_procedure"
  | "certificate"
  | "regulation";

export type DocumentParseStatus =
  | "uploaded"
  | "pending_config"
  | "pending_parse"
  | "parsing"
  | "parsed"
  | "failed"
  | "reparse_required";

export type DocumentParseProfile =
  | "manual_long"
  | "procedure_bunkering"
  | "safety_hard_parse"
  | "regulation_baseline";

export type DocumentTimeScope = "current" | "past" | "future";

export type DocumentRole =
  | "manual"
  | "equipment_register"
  | "asset_register"
  | "pms_record"
  | "specification"
  | "certificate"
  | "regulation"
  | "other";

export interface DocumentListItem {
  id: string;
  shipId: string;
  uploadedByUserId: string | null;
  originalFileName: string;
  /** Controlled-document code parsed from the filename ("EM 002 01"). */
  docCode: string | null;
  /** Codes this document's text references (SMS procedures/circulars). */
  formRefs: string[] | null;
  storageKey: string | null;
  mimeType: string;
  fileSizeBytes: number;
  checksumSha256: string;
  pageCount: number | null;
  ragflowDocumentId: string | null;
  ragflowDatasetId: string | null;
  docClass: DocumentDocClass;
  language: string | null;
  equipmentOrSystem: string | null;
  equipmentName: string | null;
  equipmentAliases: string | null;
  manufacturer: string | null;
  model: string | null;
  systemArea: string | null;
  documentPurpose: string | null;
  documentRole: DocumentRole | null;
  revision: string | null;
  timeScope: DocumentTimeScope;
  sourcePriority: number;
  contentFocus: string | null;
  parseProfile: DocumentParseProfile;
  chunkMethod: "manual" | "general";
  pdfParser: string;
  autoKeywords: number;
  autoQuestions: number;
  chunkSize: number | null;
  delimiter: string | null;
  overlapPercent: number | null;
  pageIndexEnabled: boolean;
  childChunksEnabled: boolean;
  imageTableContextWindow: number | null;
  parseStatus: DocumentParseStatus;
  extractionStatus?: "none" | "pending" | "running" | "done" | "failed";
  hasExtractedMd?: boolean;
  linkedAssets?: string[];
  parseError: string | null;
  parseProgressPercent: number | null;
  chunkCount: number | null;
  parsedAt: string | null;
  lastSyncedAt: string | null;
  metadataJson: Record<string, unknown> | null;
  parserConfigJson: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentListPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface DocumentListPage {
  items: DocumentListItem[];
  pagination: DocumentListPagination;
}

export type DocumentRemoteDeleteStatus =
  | "deleted"
  | "already_absent"
  | "skipped"
  | "failed";

export interface DocumentDeleteResult {
  id: string;
  deleted: boolean;
  remoteDeleteStatus: DocumentRemoteDeleteStatus;
  error?: string;
}

export interface BulkDeleteDocumentsResult {
  requested: number;
  deleted: number;
  failed: number;
  results: DocumentDeleteResult[];
}

export interface ListDocumentsParams {
  shipId?: string;
  docClass?: DocumentDocClass;
  parseStatus?: DocumentParseStatus;
  name?: string;
  page?: number;
  pageSize?: number;
}

export interface UploadDocumentInput {
  shipId: string;
  docClass: DocumentDocClass;
  assetId?: string;
  language?: string;
  equipmentOrSystem?: string;
  equipmentName?: string;
  equipmentAliases?: string;
  manufacturer?: string;
  model?: string;
  systemArea?: string;
  documentPurpose?: string;
  documentRole?: DocumentRole;
  revision?: string;
  timeScope?: DocumentTimeScope;
  sourcePriority?: number;
  contentFocus?: string;
}

export interface ReparseDocumentMetadataInput {
  language?: string | null;
  equipmentOrSystem?: string | null;
  equipmentName?: string | null;
  equipmentAliases?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  systemArea?: string | null;
  documentPurpose?: string | null;
  documentRole?: DocumentRole | null;
  revision?: string | null;
  timeScope?: DocumentTimeScope;
  sourcePriority?: number;
  contentFocus?: string | null;
}

export interface ReparseDocumentInput {
  docClass?: DocumentDocClass;
  metadata?: ReparseDocumentMetadataInput;
}

export interface UploadDocumentProgress {
  loadedBytes: number;
  totalBytes: number | null;
  percent: number | null;
}

export interface UploadDocumentOptions {
  onUploadProgress?: (progress: UploadDocumentProgress) => void;
}

function withDocumentListQuery(path: string, params: ListDocumentsParams): string {
  const query = new URLSearchParams();

  if (params.shipId) query.set("shipId", params.shipId);
  if (params.docClass) query.set("docClass", params.docClass);
  if (params.parseStatus) query.set("parseStatus", params.parseStatus);
  const trimmedName = params.name?.trim();
  if (trimmedName) query.set("name", trimmedName);
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));

  const queryString = query.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export async function listDocuments(
  token: string,
  params: ListDocumentsParams,
): Promise<DocumentListPage> {
  const response = await fetchWithAuth(
    withDocumentListQuery("documents", params),
    { token },
  );

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to load documents");
  }

  return response.json();
}

export interface ListPublicationsParams {
  parseStatus?: DocumentParseStatus;
  name?: string;
  page?: number;
  pageSize?: number;
}

export async function listPublications(
  token: string,
  params: ListPublicationsParams = {},
): Promise<DocumentListPage> {
  const query = new URLSearchParams();

  if (params.parseStatus) query.set("parseStatus", params.parseStatus);
  const trimmedName = params.name?.trim();
  if (trimmedName) query.set("name", trimmedName);
  if (params.page) query.set("page", String(params.page));
  if (params.pageSize) query.set("pageSize", String(params.pageSize));

  const queryString = query.toString();
  const path = queryString
    ? `documents/publications?${queryString}`
    : "documents/publications";

  const response = await fetchWithAuth(path, { token });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to load publications");
  }

  return response.json();
}

export interface PublicationCatalogItem {
  id: string;
  title: string;
  conditionalNote: string | null;
  sortOrder: number;
  documentId: string | null;
  fileName: string | null;
  parseStatus: string | null;
}

export async function listPublicationCatalog(
  token: string,
): Promise<PublicationCatalogItem[]> {
  const response = await fetchWithAuth("documents/publications/catalog", {
    token,
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to load publications catalog");
  }

  return response.json();
}

export interface CreatePublicationCatalogInput {
  title: string;
  conditionalNote?: string | null;
}

export async function createPublicationCatalogItem(
  token: string,
  input: CreatePublicationCatalogInput,
): Promise<PublicationCatalogItem> {
  const response = await fetchWithAuth("documents/publications/catalog", {
    token,
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      conditionalNote: input.conditionalNote ?? null,
    }),
    headers: { "Content-Type": "application/json" },
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to add publication");
  }

  return response.json();
}

export async function attachPublicationCatalogFile(
  token: string,
  catalogId: string,
  file: File,
): Promise<PublicationCatalogItem> {
  const form = new FormData();
  form.append("file", file);

  const response = await fetchWithAuth(
    `documents/publications/catalog/${catalogId}/file`,
    {
      token,
      method: "POST",
      body: form,
    },
  );

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? `Failed to upload ${file.name}`);
  }

  return response.json();
}

export async function detachPublicationCatalogFile(
  token: string,
  catalogId: string,
): Promise<PublicationCatalogItem> {
  const response = await fetchWithAuth(
    `documents/publications/catalog/${catalogId}/file`,
    {
      token,
      method: "DELETE",
    },
  );

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to remove publication file");
  }

  return response.json();
}

export interface UploadPublicationInput {
  language?: string;
  revision?: string;
  contentFocus?: string;
}

export async function uploadPublication(
  token: string,
  file: File,
  input: UploadPublicationInput = {},
  options: UploadDocumentOptions = {},
): Promise<DocumentListItem> {
  const form = new FormData();
  form.append("file", file);
  appendOptionalText(form, "language", input.language);
  appendOptionalText(form, "revision", input.revision);
  appendOptionalText(form, "contentFocus", input.contentFocus);

  return new Promise<DocumentListItem>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", getApiUrl("documents/publications"));
    request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.responseType = "json";

    request.upload.onprogress = (event) => {
      const totalBytes =
        event.lengthComputable && event.total > 0 ? event.total : null;
      const percent =
        totalBytes === null
          ? null
          : Math.min(100, Math.round((event.loaded / totalBytes) * 100));

      options.onUploadProgress?.({
        loadedBytes: event.loaded,
        totalBytes,
        percent,
      });
    };

    request.onload = () => {
      const responseBody = parseUploadResponse(request);

      if (request.status < 200 || request.status >= 300) {
        reject(new Error(getErrorMessage(responseBody, `Failed to upload ${file.name}`)));
        return;
      }

      options.onUploadProgress?.({
        loadedBytes: file.size,
        totalBytes: file.size,
        percent: 100,
      });
      resolve(responseBody as DocumentListItem);
    };

    request.onerror = () => {
      reject(new Error(`Failed to upload ${file.name}`));
    };

    request.send(form);
  });
}

function appendOptionalText(
  form: FormData,
  key: keyof UploadDocumentInput,
  value: string | undefined,
) {
  const normalized = value?.trim();

  if (normalized) {
    form.append(key, normalized);
  }
}

function parseUploadResponse(request: XMLHttpRequest): unknown {
  if (request.response !== null) {
    return request.response;
  }

  if (!request.responseText) {
    return null;
  }

  try {
    return JSON.parse(request.responseText);
  } catch {
    return null;
  }
}

function getErrorMessage(responseBody: unknown, fallback: string): string {
  return typeof responseBody === "object" &&
    responseBody !== null &&
    "message" in responseBody &&
    typeof responseBody.message === "string"
    ? responseBody.message
    : fallback;
}

export async function uploadDocument(
  token: string,
  file: File,
  input: UploadDocumentInput,
  options: UploadDocumentOptions = {},
): Promise<DocumentListItem> {
  const form = new FormData();
  form.append("file", file);
  form.append("shipId", input.shipId);
  form.append("docClass", input.docClass);
  appendOptionalText(form, "assetId", input.assetId);
  appendOptionalText(form, "language", input.language);
  appendOptionalText(form, "equipmentOrSystem", input.equipmentOrSystem);
  appendOptionalText(form, "equipmentName", input.equipmentName);
  appendOptionalText(form, "equipmentAliases", input.equipmentAliases);
  appendOptionalText(form, "manufacturer", input.manufacturer);
  appendOptionalText(form, "model", input.model);
  appendOptionalText(form, "systemArea", input.systemArea);
  appendOptionalText(form, "documentPurpose", input.documentPurpose);
  appendOptionalText(form, "revision", input.revision);
  appendOptionalText(form, "contentFocus", input.contentFocus);

  if (input.timeScope) {
    form.append("timeScope", input.timeScope);
  }

  if (input.documentRole) {
    form.append("documentRole", input.documentRole);
  }

  if (typeof input.sourcePriority === "number") {
    form.append("sourcePriority", String(input.sourcePriority));
  }

  return new Promise<DocumentListItem>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", getApiUrl("documents"));
    request.setRequestHeader("Authorization", `Bearer ${token}`);
    request.responseType = "json";

    request.upload.onprogress = (event) => {
      const totalBytes =
        event.lengthComputable && event.total > 0 ? event.total : null;
      const percent =
        totalBytes === null
          ? null
          : Math.min(100, Math.round((event.loaded / totalBytes) * 100));

      options.onUploadProgress?.({
        loadedBytes: event.loaded,
        totalBytes,
        percent,
      });
    };

    request.onload = () => {
      const responseBody = parseUploadResponse(request);

      if (request.status < 200 || request.status >= 300) {
        reject(new Error(getErrorMessage(responseBody, `Failed to upload ${file.name}`)));
        return;
      }

      options.onUploadProgress?.({
        loadedBytes: file.size,
        totalBytes: file.size,
        percent: 100,
      });
      resolve(responseBody as DocumentListItem);
    };

    request.onerror = () => {
      reject(new Error(`Failed to upload ${file.name}`));
    };

    request.send(form);
  });
}

export async function syncDocumentStatus(
  token: string,
  documentId: string,
): Promise<DocumentListItem> {
  const response = await fetchWithAuth(`documents/${documentId}/status-sync`, {
    token,
    method: "POST",
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to refresh document status");
  }

  return response.json();
}

/** Rename a KB document (also renames the RAGFlow doc server-side). */
export async function renameDocument(
  token: string,
  documentId: string,
  name: string,
): Promise<DocumentListItem> {
  const response = await fetchWithAuth(`documents/${documentId}/name`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Rename failed");
  }
  return response.json();
}

export interface DocumentAssetLink {
  id: string;
  assetIdInternal: string;
  displayName: string;
}

/** Assets this document is pinned/auto-matched to (KB edit modal). */
export async function fetchDocumentAssetLinks(
  token: string,
  documentId: string,
): Promise<{ pinned: DocumentAssetLink[] }> {
  const response = await fetchWithAuth(`documents/${documentId}/asset-links`, {
    token,
  });
  if (!response.ok) {
    throw new Error("Failed to load asset links");
  }
  return response.json();
}

export interface DocumentFormLinkItem {
  documentId: string;
  title: string;
  docCode: string | null;
  docClass: DocumentDocClass;
  /** "code" = found automatically by scanning the procedure/circular text
   *  for controlled-document codes; "manual" = pinned by an operator. */
  origin: "code" | "manual";
}

export interface DocumentFormLinksResponse {
  /** "forms" when editing a procedure/circular (what it references);
   *  "referencedBy" when editing a form (who references it). */
  direction: "forms" | "referencedBy";
  items: DocumentFormLinkItem[];
}

/** SMS↔forms links (KB edit modal) — merges the automatic code-scan match
 *  with manual overrides, tagged by origin so the operator can correct a
 *  wrong AI match instead of just trusting it. */
export async function fetchDocumentFormLinks(
  token: string,
  documentId: string,
): Promise<DocumentFormLinksResponse> {
  const response = await fetchWithAuth(`documents/${documentId}/form-links`, {
    token,
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to load form links");
  }
  return response.json();
}

/** Pin a form↔procedure/circular link (or restore a previously-suppressed
 *  code match). Order doesn't matter — the backend infers which side is
 *  the form by docClass. */
export async function linkDocumentForm(
  token: string,
  documentId: string,
  otherDocumentId: string,
): Promise<void> {
  const response = await fetchWithAuth(`documents/${documentId}/form-links`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ otherDocumentId }),
  });
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to link");
  }
}

/** Remove a form link — if it came from the code scan, this suppresses the
 *  match (it won't resurface, in the modal or in chat citations). */
export async function unlinkDocumentForm(
  token: string,
  documentId: string,
  otherDocumentId: string,
): Promise<void> {
  const response = await fetchWithAuth(
    `documents/${documentId}/form-links/${otherDocumentId}`,
    { token, method: "DELETE" },
  );
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to unlink");
  }
}

export async function reparseDocument(
  token: string,
  documentId: string,
  input: ReparseDocumentInput = {},
): Promise<DocumentListItem> {
  const response = await fetchWithAuth(`documents/${documentId}/reparse`, {
    token,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to queue reparse");
  }

  return response.json();
}

export async function updateDocumentPriority(
  token: string,
  documentId: string,
  sourcePriority: number,
): Promise<DocumentListItem> {
  const response = await fetchWithAuth(`documents/${documentId}/classification`, {
    token,
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sourcePriority }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to update document priority");
  }

  return response.json();
}

export async function fetchDocumentFile(
  token: string,
  documentId: string,
): Promise<Blob> {
  const response = await fetchWithAuth(`documents/${documentId}/file`, {
    token,
    method: "GET",
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to open document");
  }

  return response.blob();
}

export async function deleteDocument(
  token: string,
  documentId: string,
): Promise<DocumentDeleteResult> {
  const response = await fetchWithAuth(`documents/${documentId}`, {
    token,
    method: "DELETE",
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to delete document");
  }

  return response.json();
}

export async function bulkDeleteDocuments(
  token: string,
  documentIds: string[],
): Promise<BulkDeleteDocumentsResult> {
  const response = await fetchWithAuth("documents/bulk-delete", {
    token,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ids: documentIds }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to delete selected documents");
  }

  return response.json();
}

export async function fetchExtractedMarkdown(
  token: string,
  documentId: string,
): Promise<{ markdown: string; fileName: string }> {
  const response = await fetchWithAuth(`documents/${documentId}/extracted`, {
    token,
  });
  if (!response.ok) throw new Error("Failed to load extracted markdown");
  return response.json();
}

export async function rerunExtraction(
  token: string,
  documentId: string,
): Promise<void> {
  const response = await fetchWithAuth(
    `documents/${documentId}/extracted/rerun`,
    { token, method: "POST" },
  );
  if (!response.ok) throw new Error("Failed to queue extraction");
}
