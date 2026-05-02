import { fetchWithAuth, getApiUrl } from "./core";

export type DocumentDocClass =
  | "manual"
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

export interface DocumentListItem {
  id: string;
  shipId: string;
  uploadedByUserId: string | null;
  originalFileName: string;
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
  manufacturer: string | null;
  model: string | null;
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
  language?: string;
  equipmentOrSystem?: string;
  manufacturer?: string;
  model?: string;
  revision?: string;
  timeScope?: DocumentTimeScope;
  sourcePriority?: number;
  contentFocus?: string;
}

export interface ReparseDocumentMetadataInput {
  language?: string | null;
  equipmentOrSystem?: string | null;
  manufacturer?: string | null;
  model?: string | null;
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
  appendOptionalText(form, "language", input.language);
  appendOptionalText(form, "equipmentOrSystem", input.equipmentOrSystem);
  appendOptionalText(form, "manufacturer", input.manufacturer);
  appendOptionalText(form, "model", input.model);
  appendOptionalText(form, "revision", input.revision);
  appendOptionalText(form, "contentFocus", input.contentFocus);

  if (input.timeScope) {
    form.append("timeScope", input.timeScope);
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
