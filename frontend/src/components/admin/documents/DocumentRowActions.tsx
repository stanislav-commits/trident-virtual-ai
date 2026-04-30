import type { DocumentListItem } from "../../../api/documentsApi";
import { TrashIcon } from "../AdminPanelIcons";

interface DocumentRowActionsProps {
  document: DocumentListItem;
  isDeleting: boolean;
  onRequestDelete: (document: DocumentListItem) => void;
}

export function DocumentRowActions({
  document: targetDocument,
  isDeleting,
  onRequestDelete,
}: DocumentRowActionsProps) {
  return (
    <div className="admin-panel__document-actions">
      <button
        type="button"
        className="admin-panel__document-delete-action"
        disabled={isDeleting}
        aria-label={`Delete ${targetDocument.originalFileName}`}
        title={isDeleting ? "Deleting..." : "Delete document"}
        onClick={() => onRequestDelete(targetDocument)}
      >
        <TrashIcon />
      </button>
    </div>
  );
}
