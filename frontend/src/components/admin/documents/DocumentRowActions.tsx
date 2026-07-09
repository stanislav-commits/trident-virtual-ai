import type { DocumentListItem } from "../../../api/documentsApi";
import { RefreshIcon, TrashIcon } from "../AdminPanelIcons";
import { getDocumentReparseAction } from "./documentReparseActions";

interface DocumentRowActionsProps {
  document: DocumentListItem;
  isDeleting: boolean;
  isReparsing: boolean;
  onRequestDelete: (document: DocumentListItem) => void;
  onRequestReparse: (document: DocumentListItem) => void;
}

export function DocumentRowActions({
  document: targetDocument,
  isDeleting,
  isReparsing,
  onRequestDelete,
  onRequestReparse,
}: DocumentRowActionsProps) {
  const reparseAction = getDocumentReparseAction(targetDocument);
  const actionsDisabled = isDeleting || isReparsing;

  return (
    <div className="admin-panel__document-actions">
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
