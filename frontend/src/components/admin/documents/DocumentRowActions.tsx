import type { DocumentListItem } from "../../../api/documentsApi";
import { RefreshIcon, TagIcon, TrashIcon } from "../AdminPanelIcons";
import { getDocumentReparseAction } from "./documentReparseActions";

interface DocumentRowActionsProps {
  document: DocumentListItem;
  isDeleting: boolean;
  isReparsing: boolean;
  isUpdatingMetadata: boolean;
  onRequestDelete: (document: DocumentListItem) => void;
  onRequestReparse: (document: DocumentListItem) => void;
  onRequestMetadataEdit: (document: DocumentListItem) => void;
}

export function DocumentRowActions({
  document: targetDocument,
  isDeleting,
  isReparsing,
  isUpdatingMetadata,
  onRequestDelete,
  onRequestReparse,
  onRequestMetadataEdit,
}: DocumentRowActionsProps) {
  const reparseAction = getDocumentReparseAction(targetDocument);
  const actionsDisabled = isDeleting || isReparsing || isUpdatingMetadata;

  return (
    <div className="admin-panel__document-actions">
      <button
        type="button"
        className="admin-panel__document-metadata-action"
        disabled={actionsDisabled}
        aria-label={`Edit metadata for ${targetDocument.originalFileName}`}
        title={isUpdatingMetadata ? "Saving metadata..." : "Edit metadata"}
        onClick={() => onRequestMetadataEdit(targetDocument)}
      >
        <TagIcon />
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
