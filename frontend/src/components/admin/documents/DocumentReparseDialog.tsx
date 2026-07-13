import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type {
  DocumentDocClass,
  DocumentListItem,
  ReparseDocumentInput,
} from "../../../api/documentsApi";
import { getDocumentReparseAction } from "./documentReparseActions";
import { formatFileSize } from "./documentUploadProgress";
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

// Reparse only needs the document class — the backend derives the parse
// profile from it and re-reads all metadata from the entity (the manual
// metadata fields were removed; the extractor fills them after parsing).
interface DocumentReparseFormState {
  docClass: DocumentDocClass;
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
  return { docClass: document.docClass };
}

function buildReparseInput(
  document: DocumentListItem,
  form: DocumentReparseFormState,
): ReparseDocumentInput {
  const input: ReparseDocumentInput = {};
  if (form.docClass !== document.docClass) {
    input.docClass = form.docClass;
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
                updateForm("docClass", event.target.value as DocumentDocClass)
              }
            >
              {DOCUMENT_CLASS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="admin-panel__muted">
              Changing the class re-parses with that class's profile. All other
              metadata is re-read from the document automatically.
            </span>
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
