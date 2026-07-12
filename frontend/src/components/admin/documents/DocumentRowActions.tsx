import type { DocumentListItem } from "../../../api/documentsApi";
import { EditIcon, RefreshIcon, TrashIcon } from "../AdminPanelIcons";
import { getDocumentReparseAction } from "./documentReparseActions";

interface DocumentRowActionsProps {
  document: DocumentListItem;
  isDeleting: boolean;
  isReparsing: boolean;
  onRequestEdit: (document: DocumentListItem) => void;
  onRequestDelete: (document: DocumentListItem) => void;
  onRequestReparse: (document: DocumentListItem) => void;
}

export function DocumentRowActions({
  document: targetDocument,
  isDeleting,
  isReparsing,
  onRequestEdit,
  onRequestDelete,
  onRequestReparse,
}: DocumentRowActionsProps) {
  const reparseAction = getDocumentReparseAction(targetDocument);
  const actionsDisabled = isDeleting || isReparsing;

  return (
    <div className="admin-panel__document-actions">
      <button
        type="button"
        className="admin-panel__document-reparse-action"
        disabled={actionsDisabled}
        aria-label={`Edit ${targetDocument.originalFileName}`}
        title="Rename / edit asset links"
        onClick={() => onRequestEdit(targetDocument)}
      >
        <EditIcon />
      </button>
      {reparseAction && (
        <button
          type="button"
          className="admin-panel__document-reparse-action"
          disabled={actionsDisabled}
          aria-label={reparseAction.ariaLabel}
          title={isReparsing ? "Queueing reparse..." : reparseAction.title}
          onClick={() => onRequestReparse(targetDocument)}
        >
          <RefreshIcon />
        </button>
      )}
      <button
        type="button"
        className="admin-panel__document-delete-action"
        disabled={actionsDisabled}
        aria-label={`Delete ${targetDocument.originalFileName}`}
        title={isDeleting ? "Deleting..." : "Delete document"}
        onClick={() => onRequestDelete(targetDocument)}
      >
        <TrashIcon />
      </button>
    </div>
  );
}
