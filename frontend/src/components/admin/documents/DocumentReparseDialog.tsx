import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type {
  DocumentDocClass,
  DocumentListItem,
  DocumentTimeScope,
  ReparseDocumentInput,
  ReparseDocumentMetadataInput,
} from "../../../api/documentsApi";
import { getDocumentReparseAction } from "./documentReparseActions";
import {
  DOCUMENT_CLASS_OPTIONS,
  getDocumentClassLabel,
  getDocumentParseProfileLabel,
  getDocumentParseStatusLabel,
} from "./documentOptions";

interface DocumentReparseDialogProps {
  document: DocumentListItem;
  reparsing: boolean;
  onCancel: () => void;
  onConfirm: (input: ReparseDocumentInput) => void;
}

interface DocumentReparseFormState {
  docClass: DocumentDocClass;
  language: string;
  equipmentOrSystem: string;
  manufacturer: string;
  model: string;
  revision: string;
  timeScope: DocumentTimeScope;
  sourcePriority: string;
  contentFocus: string;
}

const TIME_SCOPE_OPTIONS: Array<{ value: DocumentTimeScope; label: string }> = [
  { value: "current", label: "Current" },
  { value: "past", label: "Past" },
  { value: "future", label: "Future" },
];

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

interface InfoItem {
  label: string;
  value: string;
}

function buildInfoItems(doc: DocumentListItem): InfoItem[] {
  const items: InfoItem[] = [];

  items.push({
    label: "File size",
    value: formatFileSize(doc.fileSizeBytes),
  });

  if (doc.pageCount !== null) {
    items.push({
      label: "Pages",
      value: String(doc.pageCount),
    });
  }

  items.push({
    label: "Status",
    value: getDocumentParseStatusLabel(doc.parseStatus),
  });

  items.push({
    label: "Class",
    value: getDocumentClassLabel(doc.docClass),
  });

  items.push({
    label: "Parse profile",
    value: getDocumentParseProfileLabel(doc.parseProfile),
  });

  if (doc.chunkCount !== null) {
    items.push({
      label: "Chunks",
      value: doc.chunkCount.toLocaleString(),
    });
  }

  if (doc.parsedAt) {
    items.push({
      label: "Last parsed",
      value: formatShortDate(doc.parsedAt),
    });
  }

  return items;
}

function buildInitialFormState(
  document: DocumentListItem,
): DocumentReparseFormState {
  return {
    docClass: document.docClass,
    language: document.language ?? "",
    equipmentOrSystem: document.equipmentOrSystem ?? "",
    manufacturer: document.manufacturer ?? "",
    model: document.model ?? "",
    revision: document.revision ?? "",
    timeScope: document.timeScope,
    sourcePriority: String(document.sourcePriority),
    contentFocus: document.contentFocus ?? "",
  };
}

function buildNullableTextOverride(
  currentValue: string | null,
  nextValue: string,
): string | null | undefined {
  const currentNormalized = currentValue?.trim() ?? "";
  const nextNormalized = nextValue.trim();

  if (nextNormalized === currentNormalized) {
    return undefined;
  }

  return nextNormalized || null;
}

function parseSourcePriority(value: string): number | undefined {
  const normalized = value.trim();

  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function buildReparseInput(
  document: DocumentListItem,
  form: DocumentReparseFormState,
): ReparseDocumentInput {
  const input: ReparseDocumentInput = {};
  const metadata: ReparseDocumentMetadataInput = {};

  if (form.docClass !== document.docClass) {
    input.docClass = form.docClass;
  }

  const textOverrides: Array<
    [
      keyof Pick<
        ReparseDocumentMetadataInput,
        | "language"
        | "equipmentOrSystem"
        | "manufacturer"
        | "model"
        | "revision"
        | "contentFocus"
      >,
      string | null,
      string,
    ]
  > = [
    ["language", document.language, form.language],
    ["equipmentOrSystem", document.equipmentOrSystem, form.equipmentOrSystem],
    ["manufacturer", document.manufacturer, form.manufacturer],
    ["model", document.model, form.model],
    ["revision", document.revision, form.revision],
    ["contentFocus", document.contentFocus, form.contentFocus],
  ];

  for (const [key, currentValue, nextValue] of textOverrides) {
    const nextOverride = buildNullableTextOverride(currentValue, nextValue);

    if (nextOverride !== undefined) {
      metadata[key] = nextOverride;
    }
  }

  if (form.timeScope !== document.timeScope) {
    metadata.timeScope = form.timeScope;
  }

  const sourcePriority = parseSourcePriority(form.sourcePriority);

  if (
    sourcePriority !== undefined &&
    sourcePriority !== document.sourcePriority
  ) {
    metadata.sourcePriority = sourcePriority;
  }

  if (Object.keys(metadata).length > 0) {
    input.metadata = metadata;
  }

  return input;
}

export function DocumentReparseDialog({
  document: targetDocument,
  reparsing,
  onCancel,
  onConfirm,
}: DocumentReparseDialogProps) {
  const action = getDocumentReparseAction(targetDocument);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [form, setForm] = useState<DocumentReparseFormState>(() =>
    buildInitialFormState(targetDocument),
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !reparsing) {
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, reparsing]);

  if (!action) {
    return null;
  }

  const updateForm = <K extends keyof DocumentReparseFormState>(
    key: K,
    value: DocumentReparseFormState[K],
  ) => {
    setForm((currentForm) => ({
      ...currentForm,
      [key]: value,
    }));
  };

  return createPortal(
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="documents-reparse-title"
      aria-describedby="documents-reparse-desc"
      onClick={(event) => {
        if (event.target === event.currentTarget && !reparsing) {
          onCancel();
        }
      }}
    >
      <div className="admin-panel__modal admin-panel__documents-reparse-modal">
        <div className="admin-panel__documents-reparse-content">
          <h2 id="documents-reparse-title" className="admin-panel__modal-title">
            {action.modalTitle}
          </h2>
          <p id="documents-reparse-desc" className="admin-panel__modal-desc">
            {action.modalBody}
          </p>

          <div
            className="admin-panel__documents-reparse-file"
            title={targetDocument.originalFileName}
          >
            <span className="admin-panel__documents-reparse-file-name">
              {targetDocument.originalFileName}
            </span>
            <span className="admin-panel__documents-reparse-file-type">
              {targetDocument.mimeType}
            </span>
          </div>

          <div className="admin-panel__documents-reparse-info-grid">
            {buildInfoItems(targetDocument).map((item) => (
              <div
                key={item.label}
                className="admin-panel__documents-reparse-info-item"
              >
                <span className="admin-panel__documents-reparse-info-label">
                  {item.label}
                </span>
                <span className="admin-panel__documents-reparse-info-value">
                  {item.value}
                </span>
              </div>
            ))}
          </div>

          {targetDocument.parseError && (
            <div className="admin-panel__documents-reparse-error">
              <span className="admin-panel__documents-reparse-error-label">
                Parse error
              </span>
              <span className="admin-panel__documents-reparse-error-text">
                {targetDocument.parseError}
              </span>
            </div>
          )}

          <div className="admin-panel__documents-reparse-advanced">
            <button
              type="button"
              className="admin-panel__documents-reparse-advanced-toggle"
              onClick={() => setShowAdvanced((currentValue) => !currentValue)}
              disabled={reparsing}
            >
              <span>Advanced options</span>
              <span>{showAdvanced ? "Hide" : "Show"}</span>
            </button>

            {showAdvanced && (
              <div className="admin-panel__documents-reparse-advanced-body">
                <div className="admin-panel__documents-reparse-advanced-copy">
                  <strong>Update document settings before reparsing</strong>
                  <span>
                    These settings may affect parsing profile and future retrieval
                    behavior.
                  </span>
                </div>

                <div className="admin-panel__documents-reparse-metadata-grid">
                  <div className="admin-panel__modal-field">
                    <label
                      className="admin-panel__field-label"
                      htmlFor="reparse-doc-class"
                    >
                      Document class
                    </label>
                    <select
                      id="reparse-doc-class"
                      className="admin-panel__select admin-panel__input--full"
                      value={form.docClass}
                      disabled={reparsing}
                      onChange={(event) =>
                        updateForm(
                          "docClass",
                          event.target.value as DocumentDocClass,
                        )
                      }
                    >
                      {DOCUMENT_CLASS_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="admin-panel__modal-field">
                    <label
                      className="admin-panel__field-label"
                      htmlFor="reparse-language"
                    >
                      Language
                    </label>
                    <input
                      id="reparse-language"
                      className="admin-panel__input admin-panel__input--full"
                      value={form.language}
                      disabled={reparsing}
                      onChange={(event) =>
                        updateForm("language", event.target.value)
                      }
                      placeholder="en"
                    />
                  </div>

                  <div className="admin-panel__modal-field">
                    <label
                      className="admin-panel__field-label"
                      htmlFor="reparse-system"
                    >
                      Equipment/system
                    </label>
                    <input
                      id="reparse-system"
                      className="admin-panel__input admin-panel__input--full"
                      value={form.equipmentOrSystem}
                      disabled={reparsing}
                      onChange={(event) =>
                        updateForm("equipmentOrSystem", event.target.value)
                      }
                    />
                  </div>

                  <div className="admin-panel__modal-field">
                    <label
                      className="admin-panel__field-label"
                      htmlFor="reparse-manufacturer"
                    >
                      Manufacturer
                    </label>
                    <input
                      id="reparse-manufacturer"
                      className="admin-panel__input admin-panel__input--full"
                      value={form.manufacturer}
                      disabled={reparsing}
                      onChange={(event) =>
                        updateForm("manufacturer", event.target.value)
                      }
                    />
                  </div>

                  <div className="admin-panel__modal-field">
                    <label
                      className="admin-panel__field-label"
                      htmlFor="reparse-model"
                    >
                      Model
                    </label>
                    <input
                      id="reparse-model"
                      className="admin-panel__input admin-panel__input--full"
                      value={form.model}
                      disabled={reparsing}
                      onChange={(event) => updateForm("model", event.target.value)}
                    />
                  </div>

                  <div className="admin-panel__modal-field">
                    <label
                      className="admin-panel__field-label"
                      htmlFor="reparse-revision"
                    >
                      Revision
                    </label>
                    <input
                      id="reparse-revision"
                      className="admin-panel__input admin-panel__input--full"
                      value={form.revision}
                      disabled={reparsing}
                      onChange={(event) =>
                        updateForm("revision", event.target.value)
                      }
                    />
                  </div>

                  <div className="admin-panel__modal-field">
                    <label
                      className="admin-panel__field-label"
                      htmlFor="reparse-scope"
                    >
                      Time scope
                    </label>
                    <select
                      id="reparse-scope"
                      className="admin-panel__select admin-panel__input--full"
                      value={form.timeScope}
                      disabled={reparsing}
                      onChange={(event) =>
                        updateForm(
                          "timeScope",
                          event.target.value as DocumentTimeScope,
                        )
                      }
                    >
                      {TIME_SCOPE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="admin-panel__modal-field">
                    <label
                      className="admin-panel__field-label"
                      htmlFor="reparse-priority"
                    >
                      Source priority
                    </label>
                    <input
                      id="reparse-priority"
                      className="admin-panel__input admin-panel__input--full"
                      type="number"
                      min="0"
                      max="1000"
                      value={form.sourcePriority}
                      disabled={reparsing}
                      onChange={(event) =>
                        updateForm("sourcePriority", event.target.value)
                      }
                    />
                  </div>

                  <div className="admin-panel__modal-field">
                    <label
                      className="admin-panel__field-label"
                      htmlFor="reparse-focus"
                    >
                      Content focus
                    </label>
                    <input
                      id="reparse-focus"
                      className="admin-panel__input admin-panel__input--full"
                      value={form.contentFocus}
                      disabled={reparsing}
                      onChange={(event) =>
                        updateForm("contentFocus", event.target.value)
                      }
                      placeholder="maintenance"
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="admin-panel__modal-actions admin-panel__documents-reparse-actions">
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--ghost"
            onClick={onCancel}
            disabled={reparsing}
            autoFocus
          >
            Cancel
          </button>
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--primary"
            onClick={() => onConfirm(buildReparseInput(targetDocument, form))}
            disabled={reparsing}
          >
            {reparsing ? "Queueing..." : action.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
