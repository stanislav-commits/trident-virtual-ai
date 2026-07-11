import { useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type {
  DocumentDocClass,
  UploadDocumentInput,
} from "../../../api/documentsApi";
import { uploadDocument } from "../../../api/documentsApi";
import type { ShipSummaryItem } from "../../../api/shipsApi";
import { UploadIcon, XIcon } from "../AdminPanelIcons";
import { DOCUMENT_CLASS_OPTIONS } from "./documentOptions";
import {
  QUEUE_STATUS_BADGES,
  QUEUE_STATUS_LABELS,
  UPLOAD_CONCURRENCY_LIMIT,
  formatFileSize,
  hasKnownUploadProgress,
  isQueueItemActive,
  isQueueItemUploadable,
  mapDocumentToQueueStatus,
  shouldShowUploadProgressTrack,
  type UploadQueueItem,
} from "./documentUploadProgress";

type ShipOption = Pick<ShipSummaryItem, "id" | "name" | "organizationName">;

interface DocumentUploadModalProps {
  token: string | null;
  ships: ShipOption[];
  initialShipId?: string;
  onClose: () => void;
  onUploaded: () => Promise<void> | void;
}

const DOCUMENT_UPLOAD_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.md,.txt";
const DOCUMENT_UPLOAD_FORMATS_LABEL = "PDF, DOC/DOCX, XLS/XLSX, MD, TXT";

function formatShipLabel(ship: ShipOption): string {
  return ship.organizationName
    ? `${ship.name} (${ship.organizationName})`
    : ship.name;
}

function getFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function createQueueId(file: File): string {
  return `${getFileKey(file)}:${crypto.randomUUID()}`;
}

function formatParseStatus(value: string): string {
  return value.replace(/_/g, " ");
}

export function DocumentUploadModal({
  token,
  ships,
  initialShipId,
  onClose,
  onUploaded,
}: DocumentUploadModalProps) {
  const initialShip =
    initialShipId && ships.some((ship) => ship.id === initialShipId)
      ? initialShipId
      : ships.length === 1
        ? ships[0].id
        : "";
  const [shipId, setShipId] = useState(initialShip);
  const [docClass, setDocClass] = useState<DocumentDocClass>(
    // Keep "Manuals" as the default class for new uploads.
    DOCUMENT_CLASS_OPTIONS.find((option) => option.value === "manual")?.value ??
      DOCUMENT_CLASS_OPTIONS[0].value,
  );
  const [queue, setQueue] = useState<UploadQueueItem[]>([]);
  const [submitError, setSubmitError] = useState("");
  const [completionMessage, setCompletionMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalSize = useMemo(
    () => queue.reduce((sum, item) => sum + item.file.size, 0),
    [queue],
  );
  const pendingUploadCount = queue.filter(isQueueItemUploadable).length;
  const activeUploadCount = queue.filter(isQueueItemActive).length;
  const completedUploadCount = queue.filter(
    (item) =>
      item.status === "uploaded" ||
      item.status === "ingesting" ||
      item.status === "parsing" ||
      item.status === "parsed",
  ).length;

  const canSubmit =
    Boolean(token) && Boolean(shipId) && pendingUploadCount > 0 && !submitting;

  const updateQueueItem = (
    itemId: string,
    patch: Partial<Omit<UploadQueueItem, "id" | "file">>,
  ) => {
    setQueue((currentQueue) =>
      currentQueue.map((item) =>
        item.id === itemId ? { ...item, ...patch } : item,
      ),
    );
  };

  const addFiles = (nextFiles: File[]) => {
    if (nextFiles.length === 0) {
      return;
    }

    setCompletionMessage("");
    setSubmitError("");
    setQueue((currentQueue) => {
      const knownKeys = new Set(currentQueue.map((item) => getFileKey(item.file)));
      const deduped = nextFiles.filter((file) => !knownKeys.has(getFileKey(file)));

      return [
        ...currentQueue,
        ...deduped.map((file) => ({
          id: createQueueId(file),
          file,
          status: "queued" as const,
          uploadProgressPercent: null,
        })),
      ];
    });
  };

  const removeQueueItem = (itemId: string) => {
    setQueue((currentQueue) =>
      currentQueue.filter((item) => item.id !== itemId),
    );
  };

  // No manual metadata: the extractor identifies manufacturer/model from the
  // document and auto-matches it to the asset register after parsing.
  const buildUploadInput = (): UploadDocumentInput => ({
    shipId,
    docClass,
  });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!token) {
      setSubmitError("Authentication token is missing.");
      return;
    }

    if (!shipId) {
      setSubmitError("Select a ship before uploading documents.");
      return;
    }

    const uploadableItems = queue.filter(isQueueItemUploadable);

    if (uploadableItems.length === 0) {
      setSubmitError("Select at least one queued file.");
      return;
    }

    const uploadInput = buildUploadInput();

    setSubmitting(true);
    setSubmitError("");
    setCompletionMessage("");

    let nextItemIndex = 0;
    let succeeded = 0;
    let failed = 0;

    const uploadNext = async () => {
      while (nextItemIndex < uploadableItems.length) {
        const item = uploadableItems[nextItemIndex];
        nextItemIndex += 1;

        updateQueueItem(item.id, {
          status: "uploading",
          error: undefined,
          parseStatus: undefined,
          uploadProgressPercent: 0,
        });

        try {
          const document = await uploadDocument(token, item.file, uploadInput, {
            onUploadProgress: (progress) => {
              updateQueueItem(item.id, {
                uploadProgressPercent: progress.percent,
              });
            },
          });
          const status = mapDocumentToQueueStatus(document);

          if (status === "failed") {
            failed += 1;
          } else {
            succeeded += 1;
          }

          updateQueueItem(item.id, {
            status,
            uploadProgressPercent: 100,
            documentId: document.id,
            parseStatus: document.parseStatus,
            error: document.parseError ?? undefined,
          });
        } catch (error) {
          failed += 1;
          updateQueueItem(item.id, {
            status: "failed",
            error:
              error instanceof Error
                ? error.message
                : "Failed to upload this document.",
          });
        }
      }
    };

    try {
      const workerCount = Math.min(
        UPLOAD_CONCURRENCY_LIMIT,
        uploadableItems.length,
      );
      await Promise.all(
        Array.from({ length: workerCount }, () => uploadNext()),
      );

      if (succeeded > 0) {
        await onUploaded();
      }

      if (failed > 0) {
        setSubmitError(
          `${failed} file${failed === 1 ? "" : "s"} failed. You can remove or retry failed files.`,
        );
      } else {
        setCompletionMessage(
          `${succeeded} file${succeeded === 1 ? "" : "s"} submitted for parsing.`,
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="documents-upload-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      <div className="admin-panel__modal admin-panel__modal--large admin-panel__modal--scrollable admin-panel__documents-upload-modal">
        <button
          type="button"
          className="admin-panel__modal-close"
          onClick={onClose}
          disabled={submitting}
          aria-label="Close"
        >
          <XIcon />
        </button>

        <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
          <UploadIcon />
        </div>
        <h2 id="documents-upload-title" className="admin-panel__modal-title">
          Upload documents
        </h2>
        <p className="admin-panel__modal-desc">
          Add files to a ship dataset and send them to RAGFlow for parsing.
        </p>

        <form
          className="admin-panel__modal-form admin-panel__modal-form--fill"
          onSubmit={handleSubmit}
        >
          <div className="admin-panel__modal-body admin-panel__documents-upload-body">
            {submitError && (
              <div className="admin-panel__error" role="alert">
                {submitError}
              </div>
            )}

            {completionMessage && (
              <div className="admin-panel__documents-upload-success" role="status">
                {completionMessage}
              </div>
            )}

            <div className="admin-panel__documents-upload-required">
              <div className="admin-panel__modal-field-row">
                {/* The vessel comes from the page's active-vessel context —
                    only ask when it genuinely can't be resolved. */}
                {!initialShip && (
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label" htmlFor="upload-ship">
                      Ship
                    </label>
                    <select
                      id="upload-ship"
                      className="admin-panel__select admin-panel__input--full"
                      value={shipId}
                      disabled={submitting}
                      onChange={(event) => setShipId(event.target.value)}
                    >
                      <option value="">Select ship</option>
                      {ships.map((ship) => (
                        <option key={ship.id} value={ship.id}>
                          {formatShipLabel(ship)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label" htmlFor="upload-class">
                    Document class
                  </label>
                  <select
                    id="upload-class"
                    className="admin-panel__select admin-panel__input--full"
                    value={docClass}
                    disabled={submitting}
                    onChange={(event) =>
                      setDocClass(event.target.value as DocumentDocClass)
                    }
                  >
                    {DOCUMENT_CLASS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="admin-panel__modal-field">
              <div className="admin-panel__field-label-row">
                <label className="admin-panel__field-label" htmlFor="upload-files">
                  Files
                </label>
                <span className="admin-panel__inline-meta">
                  {queue.length > 0
                    ? `${queue.length} file${queue.length === 1 ? "" : "s"} (${formatFileSize(totalSize)})`
                    : "No files selected"}
                </span>
              </div>
              <input
                ref={fileInputRef}
                id="upload-files"
                type="file"
                className="admin-panel__file-input"
                multiple
                accept={DOCUMENT_UPLOAD_ACCEPT}
                disabled={submitting}
                onChange={(event) => {
                  addFiles(event.target.files ? Array.from(event.target.files) : []);
                  event.target.value = "";
                }}
              />
              <button
                type="button"
                className="admin-panel__document-upload-picker"
                disabled={submitting}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (!submitting) {
                    addFiles(Array.from(event.dataTransfer.files));
                  }
                }}
              >
                <span className="admin-panel__document-upload-picker-icon">
                  <UploadIcon />
                </span>
                <span className="admin-panel__document-upload-picker-copy">
                  <span className="admin-panel__document-upload-picker-title">
                    {queue.length > 0 ? "Add more files" : "Select files"}
                  </span>
                  <span className="admin-panel__document-upload-picker-note">
                    {`Browse or drop one or many documents here. Supported formats: ${DOCUMENT_UPLOAD_FORMATS_LABEL}.`}
                  </span>
                </span>
              </button>

              {queue.length > 0 && (
                <div className="admin-panel__document-upload-queue">
                  {queue.map((item) => (
                    <div
                      key={item.id}
                      className={`admin-panel__document-upload-file admin-panel__document-upload-file--${item.status}`}
                    >
                      <div className="admin-panel__document-upload-file-main">
                        <span className="admin-panel__document-upload-file-name">
                          {item.file.name}
                        </span>
                        <span className="admin-panel__inline-meta">
                          {formatFileSize(item.file.size)}
                          {item.parseStatus
                            ? ` / ${formatParseStatus(item.parseStatus)}`
                            : ""}
                        </span>
                        <div className="admin-panel__document-upload-progress-stack">
                          <div className="admin-panel__document-upload-progress-row">
                            <span className="admin-panel__document-upload-progress-label">
                              Upload
                            </span>
                            <span className="admin-panel__document-upload-progress-value">
                              {hasKnownUploadProgress(item)
                                ? `${item.uploadProgressPercent}%`
                                : item.status === "queued"
                                  ? "Queued"
                                  : "In progress"}
                            </span>
                            {shouldShowUploadProgressTrack(item) && (
                              <span
                                className={`admin-panel__document-progress ${
                                  hasKnownUploadProgress(item)
                                    ? "admin-panel__document-progress--determinate"
                                    : "admin-panel__document-progress--indeterminate"
                                }`}
                                aria-label={
                                  hasKnownUploadProgress(item)
                                    ? `Upload ${item.uploadProgressPercent}%`
                                    : "Upload progress"
                                }
                              >
                                {hasKnownUploadProgress(item) && (
                                  <span
                                    className="admin-panel__document-progress-fill"
                                    style={{
                                      width: `${item.uploadProgressPercent}%`,
                                    }}
                                  />
                                )}
                              </span>
                            )}
                          </div>
                          {item.parseStatus && (
                            <div className="admin-panel__document-upload-progress-row">
                              <span className="admin-panel__document-upload-progress-label">
                                Parse/index
                              </span>
                              <span className="admin-panel__document-upload-progress-value">
                                {formatParseStatus(item.parseStatus)}
                              </span>
                              <span
                                className={`admin-panel__document-progress ${
                                  item.parseStatus === "parsing" ||
                                  item.parseStatus === "pending_parse" ||
                                  item.parseStatus === "pending_config"
                                    ? "admin-panel__document-progress--indeterminate"
                                    : item.parseStatus === "parsed"
                                      ? "admin-panel__document-progress--complete"
                                      : ""
                                }`}
                                aria-label={`Parse status ${formatParseStatus(item.parseStatus)}`}
                              >
                                {item.parseStatus === "parsed" && (
                                  <span
                                    className="admin-panel__document-progress-fill"
                                    style={{ width: "100%" }}
                                  />
                                )}
                              </span>
                            </div>
                          )}
                        </div>
                        {item.error && (
                          <span className="admin-panel__document-upload-error">
                            {item.error}
                          </span>
                        )}
                      </div>
                      <span
                        className={`admin-panel__badge ${QUEUE_STATUS_BADGES[item.status]}`}
                      >
                        {QUEUE_STATUS_LABELS[item.status]}
                      </span>
                      <button
                        type="button"
                        className="admin-panel__document-upload-remove"
                        disabled={submitting}
                        onClick={() => removeQueueItem(item.id)}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>

          <div className="admin-panel__modal-footer">
            {submitting && (
              <div className="admin-panel__inline-progress">
                <div className="admin-panel__spinner" />
                <span className="admin-panel__muted">
                  Uploading with a {UPLOAD_CONCURRENCY_LIMIT}-file limit.
                  {activeUploadCount > 0
                    ? ` ${activeUploadCount} active, ${completedUploadCount} submitted.`
                    : ""}
                </span>
              </div>
            )}

            <div className="admin-panel__modal-actions">
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--ghost"
                onClick={onClose}
                disabled={submitting}
              >
                {completionMessage ? "Done" : "Cancel"}
              </button>
              <button
                type="submit"
                className="admin-panel__btn admin-panel__btn--primary"
                disabled={!canSubmit}
              >
                {submitting
                  ? "Uploading..."
                  : pendingUploadCount > 0
                    ? `Upload ${pendingUploadCount} document${pendingUploadCount === 1 ? "" : "s"}`
                    : "All files submitted"}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
