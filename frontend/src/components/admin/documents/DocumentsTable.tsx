import type { ShipSummaryItem } from "../../../api/shipsApi";
import type { DocumentListItem, DocumentParseStatus } from "../../../api/documentsApi";
import { TrashIcon } from "../AdminPanelIcons";
import {
  getDocumentClassLabel,
  getDocumentParseProfileLabel,
  getDocumentParseStatusLabel,
} from "./documentOptions";

interface DocumentsTableProps {
  documents: DocumentListItem[];
  shipsById: Map<string, Pick<ShipSummaryItem, "id" | "name" | "organizationName">>;
  selectedDocumentIds: Set<string>;
  allPageDocumentsSelected: boolean;
  onTogglePageSelection: () => void;
  onToggleDocumentSelection: (documentId: string) => void;
  onViewDocument: (document: DocumentListItem) => void;
  onRequestDelete: (document: DocumentListItem) => void;
  openingDocumentId: string | null;
  deletingDocumentIds: Set<string>;
}

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const STATUS_BADGE_CLASS: Record<DocumentParseStatus, string> = {
  uploaded: "admin-panel__badge--manual-pending",
  pending_config: "admin-panel__badge--manual-pending",
  pending_parse: "admin-panel__badge--manual-pending",
  parsing: "admin-panel__badge--manual-running",
  parsed: "admin-panel__badge--manual-done",
  failed: "admin-panel__badge--manual-fail",
  reparse_required: "admin-panel__badge--manual-cancel",
};

function formatUpdatedAt(value: string): string {
  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime())
    ? "-"
    : dateTimeFormatter.format(parsedDate);
}

function getShipLabel(
  shipId: string,
  shipsById: DocumentsTableProps["shipsById"],
): string {
  const ship = shipsById.get(shipId);

  if (ship) {
    return ship.organizationName ? `${ship.name} (${ship.organizationName})` : ship.name;
  }

  return shipId.slice(0, 8);
}

function getParseProgressPercent(document: DocumentListItem): number | null {
  if (typeof document.parseProgressPercent !== "number") {
    return null;
  }

  const percent = Math.max(0, Math.min(100, document.parseProgressPercent));
  return Math.round((percent + Number.EPSILON) * 100) / 100;
}

function formatParseProgressPercent(percent: number): string {
  return percent
    .toFixed(2)
    .replace(/\.00$/, "")
    .replace(/(\.\d)0$/, "$1");
}

interface DocumentStatusCellProps {
  document: DocumentListItem;
}

function DocumentStatusCell({ document }: DocumentStatusCellProps) {
  const label = getDocumentParseStatusLabel(document.parseStatus);
  const badgeClass = `admin-panel__badge ${STATUS_BADGE_CLASS[document.parseStatus]}`;
  const parsedAtTitle = document.parsedAt
    ? `Parsed ${formatUpdatedAt(document.parsedAt)}`
    : undefined;

  if (document.parseStatus === "parsing") {
    const percent = getParseProgressPercent(document);

    return (
      <div className="admin-panel__document-status-cell">
        <div className="admin-panel__document-status-row">
          <span className={badgeClass}>{label}</span>
          {percent !== null && (
            <span className="admin-panel__document-status-percent">
              {formatParseProgressPercent(percent)}%
            </span>
          )}
        </div>
        {percent !== null ? (
          <span
            className="admin-panel__document-progress admin-panel__document-progress--determinate"
            aria-label={`Parse progress ${formatParseProgressPercent(percent)}%`}
          >
            <span
              className="admin-panel__document-progress-fill"
              style={{ width: `${percent}%` }}
            />
          </span>
        ) : (
          <span
            className="admin-panel__document-progress admin-panel__document-progress--indeterminate"
            aria-label="Parsing in progress"
          />
        )}
      </div>
    );
  }

  if (document.parseStatus === "failed") {
    return (
      <div className="admin-panel__document-status-cell">
        <span className={badgeClass}>{label}</span>
        {document.parseError && (
          <span
            className="admin-panel__document-status-note admin-panel__document-status-note--error"
            title={document.parseError}
          >
            {document.parseError}
          </span>
        )}
      </div>
    );
  }

  return (
    <span className={badgeClass} title={parsedAtTitle}>
      {label}
    </span>
  );
}

export function DocumentsTable({
  documents,
  shipsById,
  selectedDocumentIds,
  allPageDocumentsSelected,
  onTogglePageSelection,
  onToggleDocumentSelection,
  onViewDocument,
  onRequestDelete,
  openingDocumentId,
  deletingDocumentIds,
}: DocumentsTableProps) {
  return (
    <div className="admin-panel__table-wrap admin-panel__documents-table-wrap">
      <table className="admin-panel__table admin-panel__table--documents">
        <colgroup>
          <col className="admin-panel__documents-col--select" />
          <col className="admin-panel__documents-col--file" />
          <col className="admin-panel__documents-col--ship" />
          <col className="admin-panel__documents-col--class" />
          <col className="admin-panel__documents-col--status" />
          <col className="admin-panel__documents-col--profile" />
          <col className="admin-panel__documents-col--chunks" />
          <col className="admin-panel__documents-col--updated" />
          <col className="admin-panel__documents-col--actions" />
        </colgroup>
        <thead>
          <tr>
            <th className="admin-panel__th admin-panel__th--select">
              <input
                type="checkbox"
                className="admin-panel__selection-check"
                checked={allPageDocumentsSelected}
                onChange={onTogglePageSelection}
                aria-label="Select all documents on this page"
              />
            </th>
            <th className="admin-panel__th">File name</th>
            <th className="admin-panel__th">Ship</th>
            <th className="admin-panel__th">Class</th>
            <th className="admin-panel__th">Parse status</th>
            <th className="admin-panel__th">Parse profile</th>
            <th className="admin-panel__th admin-panel__th--numeric">Chunks</th>
            <th className="admin-panel__th">Updated</th>
            <th className="admin-panel__th admin-panel__th--actions admin-panel__th--actions-sticky">
              <span className="admin-panel__visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => {
            const isSelected = selectedDocumentIds.has(document.id);
            const isDeleting = deletingDocumentIds.has(document.id);
            const canView = Boolean(
              document.ragflowDatasetId && document.ragflowDocumentId,
            );
            const fileTitle = document.mimeType
              ? `${document.originalFileName} • ${document.mimeType}`
              : document.originalFileName;

            return (
              <tr
                key={document.id}
                className={`admin-panel__row${isSelected ? " admin-panel__row--selected" : ""}`}
              >
                <td className="admin-panel__td admin-panel__td--select">
                  <input
                    type="checkbox"
                    className="admin-panel__selection-check"
                    checked={isSelected}
                    disabled={isDeleting}
                    onChange={() => onToggleDocumentSelection(document.id)}
                    aria-label={`Select ${document.originalFileName}`}
                  />
                </td>
                <td className="admin-panel__td admin-panel__td--document-name">
                  <button
                    type="button"
                    className="admin-panel__document-name-button"
                    disabled={!canView || openingDocumentId === document.id}
                    onClick={() => onViewDocument(document)}
                    title={canView ? `Open ${fileTitle}` : fileTitle}
                  >
                    <span className="admin-panel__document-name-text">
                      {document.originalFileName}
                    </span>
                  </button>
                </td>
                <td className="admin-panel__td">
                  {getShipLabel(document.shipId, shipsById)}
                </td>
                <td className="admin-panel__td">
                  <span className="admin-panel__badge">
                    {getDocumentClassLabel(document.docClass)}
                  </span>
                </td>
                <td className="admin-panel__td admin-panel__td--status">
                  <DocumentStatusCell document={document} />
                </td>
                <td className="admin-panel__td admin-panel__td--serial">
                  {getDocumentParseProfileLabel(document.parseProfile)}
                </td>
                <td className="admin-panel__td admin-panel__td--serial admin-panel__td--numeric">
                  {document.chunkCount ?? "-"}
                </td>
                <td className="admin-panel__td admin-panel__td--serial">
                  {formatUpdatedAt(document.updatedAt)}
                </td>
                <td className="admin-panel__td admin-panel__td--actions admin-panel__td--actions-sticky">
                  <button
                    type="button"
                    className="admin-panel__row-action-icon admin-panel__row-action-icon--danger"
                    disabled={isDeleting}
                    onClick={() => onRequestDelete(document)}
                    aria-label={`Delete ${document.originalFileName}`}
                    title={isDeleting ? "Deleting..." : "Delete document"}
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
