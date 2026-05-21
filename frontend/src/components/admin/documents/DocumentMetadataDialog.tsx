import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type {
  DocumentListItem,
  DocumentMetadataInput,
  DocumentRole,
} from "../../../api/documentsApi";
import { TagIcon, XIcon } from "../AdminPanelIcons";
import { DOCUMENT_ROLE_OPTIONS } from "./documentOptions";

interface DocumentMetadataDialogProps {
  document: DocumentListItem;
  saving: boolean;
  onCancel: () => void;
  onConfirm: (input: DocumentMetadataInput) => void;
}

interface DocumentMetadataFormState {
  equipmentName: string;
  equipmentAliases: string;
  manufacturer: string;
  model: string;
  systemArea: string;
  documentPurpose: string;
  documentRole: "" | DocumentRole;
  sourcePriority: string;
}

const SOURCE_PRIORITY_ERROR =
  "Source priority must be a whole number from 0 to 1000.";

function buildInitialFormState(
  document: DocumentListItem,
): DocumentMetadataFormState {
  return {
    equipmentName: document.equipmentName ?? "",
    equipmentAliases: document.equipmentAliases ?? "",
    manufacturer: document.manufacturer ?? "",
    model: document.model ?? "",
    systemArea: document.systemArea ?? "",
    documentPurpose: document.documentPurpose ?? "",
    documentRole: document.documentRole ?? "",
    sourcePriority: String(document.sourcePriority),
  };
}

function normalizeNullableText(value: string): string | null {
  const normalized = value.trim();
  return normalized || null;
}

function parseSourcePriority(value: string): number {
  const normalized = value.trim();
  const parsedPriority = Number(normalized);

  if (
    !normalized ||
    !Number.isInteger(parsedPriority) ||
    parsedPriority < 0 ||
    parsedPriority > 1000
  ) {
    throw new Error(SOURCE_PRIORITY_ERROR);
  }

  return parsedPriority;
}

export function DocumentMetadataDialog({
  document,
  saving,
  onCancel,
  onConfirm,
}: DocumentMetadataDialogProps) {
  const [formState, setFormState] = useState<DocumentMetadataFormState>(() =>
    buildInitialFormState(document),
  );
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) {
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel, saving]);

  const updateField = <TField extends keyof DocumentMetadataFormState>(
    field: TField,
    value: DocumentMetadataFormState[TField],
  ) => {
    setSubmitError("");
    setFormState((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    try {
      onConfirm({
        equipmentName: normalizeNullableText(formState.equipmentName),
        equipmentAliases: normalizeNullableText(formState.equipmentAliases),
        manufacturer: normalizeNullableText(formState.manufacturer),
        model: normalizeNullableText(formState.model),
        systemArea: normalizeNullableText(formState.systemArea),
        documentPurpose: normalizeNullableText(formState.documentPurpose),
        documentRole: formState.documentRole || null,
        sourcePriority: parseSourcePriority(formState.sourcePriority),
      });
    } catch (error) {
      setSubmitError(
        error instanceof Error ? error.message : "Metadata could not be saved.",
      );
    }
  };

  return createPortal(
    <div
      className="admin-panel__modal-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) {
          onCancel();
        }
      }}
    >
      <form
        className="admin-panel__modal admin-panel__modal--large admin-panel__modal--scrollable admin-panel__documents-metadata-modal"
        onSubmit={handleSubmit}
      >
        <button
          type="button"
          className="admin-panel__modal-close"
          aria-label="Close metadata dialog"
          disabled={saving}
          onClick={onCancel}
        >
          <XIcon />
        </button>

        <div className="admin-panel__modal-head">
          <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
            <TagIcon />
          </div>
          <h2 className="admin-panel__modal-title">Document metadata</h2>
          <p className="admin-panel__modal-desc" title={document.originalFileName}>
            {document.originalFileName}
          </p>
        </div>

        <div className="admin-panel__modal-body">
          <div className="admin-panel__modal-field-row">
            <label className="admin-panel__modal-field">
              <span className="admin-panel__field-label">Equipment name</span>
              <input
                className="admin-panel__input"
                value={formState.equipmentName}
                disabled={saving}
                maxLength={255}
                onChange={(event) =>
                  updateField("equipmentName", event.currentTarget.value)
                }
              />
            </label>

            <label className="admin-panel__modal-field">
              <span className="admin-panel__field-label">System/Area</span>
              <input
                className="admin-panel__input"
                value={formState.systemArea}
                disabled={saving}
                maxLength={255}
                onChange={(event) =>
                  updateField("systemArea", event.currentTarget.value)
                }
              />
            </label>
          </div>

          <label className="admin-panel__modal-field">
            <span className="admin-panel__field-label">Equipment aliases</span>
            <textarea
              className="admin-panel__input admin-panel__textarea admin-panel__documents-metadata-aliases"
              value={formState.equipmentAliases}
              disabled={saving}
              maxLength={2000}
              onChange={(event) =>
                updateField("equipmentAliases", event.currentTarget.value)
              }
            />
          </label>

          <div className="admin-panel__modal-field-row">
            <label className="admin-panel__modal-field">
              <span className="admin-panel__field-label">Manufacturer</span>
              <input
                className="admin-panel__input"
                value={formState.manufacturer}
                disabled={saving}
                maxLength={255}
                onChange={(event) =>
                  updateField("manufacturer", event.currentTarget.value)
                }
              />
            </label>

            <label className="admin-panel__modal-field">
              <span className="admin-panel__field-label">Model</span>
              <input
                className="admin-panel__input"
                value={formState.model}
                disabled={saving}
                maxLength={255}
                onChange={(event) =>
                  updateField("model", event.currentTarget.value)
                }
              />
            </label>
          </div>

          <div className="admin-panel__modal-field-row">
            <label className="admin-panel__modal-field">
              <span className="admin-panel__field-label">Document role</span>
              <select
                className="admin-panel__select"
                value={formState.documentRole}
                disabled={saving}
                onChange={(event) =>
                  updateField(
                    "documentRole",
                    event.currentTarget.value as "" | DocumentRole,
                  )
                }
              >
                <option value="">Unset</option>
                {DOCUMENT_ROLE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="admin-panel__modal-field">
              <span className="admin-panel__field-label">Source priority</span>
              <input
                className="admin-panel__input"
                type="number"
                min="0"
                max="1000"
                step="1"
                value={formState.sourcePriority}
                disabled={saving}
                onChange={(event) =>
                  updateField("sourcePriority", event.currentTarget.value)
                }
              />
            </label>
          </div>

          <label className="admin-panel__modal-field">
            <span className="admin-panel__field-label">Document purpose</span>
            <textarea
              className="admin-panel__input admin-panel__textarea"
              value={formState.documentPurpose}
              disabled={saving}
              maxLength={4000}
              onChange={(event) =>
                updateField("documentPurpose", event.currentTarget.value)
              }
            />
          </label>

          {submitError && (
            <div className="admin-panel__error" role="alert">
              {submitError}
            </div>
          )}
        </div>

        <div className="admin-panel__modal-footer">
          <div className="admin-panel__modal-actions">
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              disabled={saving}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="admin-panel__btn admin-panel__btn--primary"
              disabled={saving}
            >
              {saving ? "Saving..." : "Save metadata"}
            </button>
          </div>
        </div>
      </form>
    </div>,
    window.document.body,
  );
}
