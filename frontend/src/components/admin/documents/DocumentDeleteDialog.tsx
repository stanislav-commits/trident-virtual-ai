import { createPortal } from "react-dom";
import type { DocumentListItem } from "../../../api/documentsApi";

interface DocumentDeleteDialogProps {
  documents: DocumentListItem[];
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DocumentDeleteDialog({
  documents,
  deleting,
  onCancel,
  onConfirm,
}: DocumentDeleteDialogProps) {
  const isBulkDelete = documents.length > 1;
  const title = isBulkDelete
    ? "Delete selected documents?"
    : "Delete this document?";
  const primaryName = documents[0]?.originalFileName ?? "document";

  return createPortal(
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="documents-delete-title"
      onClick={(event) => {
        if (event.target === event.currentTarget && !deleting) {
          onCancel();
        }
      }}
    >
      <div className="admin-panel__modal admin-panel__documents-delete-modal">
        <h2 id="documents-delete-title" className="admin-panel__modal-title">
          {title}
        </h2>
        <p className="admin-panel__modal-desc">
          {isBulkDelete
            ? `${documents.length} documents will be removed from Trident and RAGFlow where possible. This cannot be undone.`
            : `This will remove "${primaryName}" from Trident and RAGFlow where possible. This cannot be undone.`}
        </p>

        {isBulkDelete && (
          <div className="admin-panel__documents-delete-list">
            {documents.slice(0, 5).map((document) => (
              <span
                key={document.id}
                className="admin-panel__documents-delete-list-item"
              >
                {document.originalFileName}
              </span>
            ))}
            {documents.length > 5 && (
              <span className="admin-panel__documents-delete-list-item admin-panel__documents-delete-list-item--muted">
                +{documents.length - 5} more
              </span>
            )}
          </div>
        )}

        <div className="admin-panel__modal-actions">
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--ghost"
            onClick={onCancel}
            disabled={deleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--danger"
            onClick={onConfirm}
            disabled={deleting}
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
