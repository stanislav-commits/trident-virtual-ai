import type {
  DocumentListItem,
  DocumentParseStatus,
} from "../../../api/documentsApi";

export type UploadQueueStatus =
  | "queued"
  | "uploading"
  | "uploaded"
  | "ingesting"
  | "parsing"
  | "parsed"
  | "failed";

export interface UploadQueueItem {
  id: string;
  file: File;
  status: UploadQueueStatus;
  uploadProgressPercent: number | null;
  documentId?: string;
  parseStatus?: DocumentParseStatus;
  error?: string;
}

export const UPLOAD_CONCURRENCY_LIMIT = 2;

export const QUEUE_STATUS_LABELS: Record<UploadQueueStatus, string> = {
  queued: "Queued",
  uploading: "Uploading",
  uploaded: "Uploaded",
  ingesting: "Ingesting",
  parsing: "Parsing",
  parsed: "Parsed",
  failed: "Failed",
};

export const QUEUE_STATUS_BADGES: Record<UploadQueueStatus, string> = {
  queued: "admin-panel__badge--manual-cancel",
  uploading: "admin-panel__badge--manual-running",
  uploaded: "admin-panel__badge--manual-pending",
  ingesting: "admin-panel__badge--manual-pending",
  parsing: "admin-panel__badge--manual-running",
  parsed: "admin-panel__badge--manual-done",
  failed: "admin-panel__badge--manual-fail",
};

export function mapDocumentToQueueStatus(
  document: DocumentListItem,
): UploadQueueStatus {
  if (document.parseStatus === "failed") {
    return "failed";
  }

  if (document.parseStatus === "parsed") {
    return "parsed";
  }

  if (document.parseStatus === "parsing") {
    return "parsing";
  }

  if (
    document.parseStatus === "pending_config" ||
    document.parseStatus === "pending_parse"
  ) {
    return "ingesting";
  }

  return "uploaded";
}

export function isQueueItemUploadable(item: UploadQueueItem): boolean {
  return item.status === "queued" || item.status === "failed";
}

export function isQueueItemActive(item: UploadQueueItem): boolean {
  return (
    item.status === "uploading" ||
    item.status === "ingesting" ||
    item.status === "parsing"
  );
}

export function hasKnownUploadProgress(
  item: UploadQueueItem,
): item is UploadQueueItem & { uploadProgressPercent: number } {
  return typeof item.uploadProgressPercent === "number";
}

export function shouldShowUploadProgressTrack(item: UploadQueueItem): boolean {
  return item.status === "uploading" || hasKnownUploadProgress(item);
}
