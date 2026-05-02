import type {
  DocumentDocClass,
  DocumentListItem,
  DocumentParseStatus,
} from "../../../api/documentsApi";
import type { ShipSummaryItem } from "../../../api/shipsApi";
import { DocumentRowActions } from "./DocumentRowActions";
import {
  getDocumentClassLabel,
  getDocumentParseProfileLabel,
  getDocumentParseStatusLabel,
} from "./documentOptions";

interface DocumentsTableProps {
  documents: DocumentListItem[];
  shipsById: Map<
    string,
    Pick<ShipSummaryItem, "id" | "name" | "organizationName">
  >;
  selectedDocumentIds: Set<string>;
  allPageDocumentsSelected: boolean;
  onTogglePageSelection: () => void;
  onToggleDocumentSelection: (documentId: string) => void;
  onViewDocument: (document: DocumentListItem) => void;
  onRequestDelete: (document: DocumentListItem) => void;
  onRequestReparse: (document: DocumentListItem) => void;
  openingDocumentId: string | null;
  deletingDocumentIds: Set<string>;
  reparsingDocumentIds: Set<string>;
}

const fullDateTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const compactDateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
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

function formatDateTime(value: string): string {
  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime())
    ? "-"
    : fullDateTimeFormatter.format(parsedDate);
}

function formatCompactDate(value: string): string {
  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime())
    ? "-"
    : compactDateFormatter.format(parsedDate);
}

function getShipDisplay(
  shipId: string,
  shipsById: DocumentsTableProps["shipsById"],
): { name: string; organizationName?: string } {
  const ship = shipsById.get(shipId);

  if (ship) {
    return {
      name: ship.name,
      organizationName: ship.organizationName ?? undefined,
    };
  }

  return { name: shipId.slice(0, 8) };
}

function getCompactParseProfileLabel(document: DocumentListItem): string {
  return getDocumentParseProfileLabel(document.parseProfile).replace(
    /\s+profile$/i,
    "",
  );
}

function getClassChipLabel(docClass: DocumentDocClass): string {
  if (docClass === "historical_procedure") {
    return "Historical Proc.";
  }

  return getDocumentClassLabel(docClass);
}

function formatChunkCount(chunkCount: number | null): string | null {
  if (chunkCount === null) {
    return null;
  }

  return `${chunkCount.toLocaleString()} chunk${chunkCount === 1 ? "" : "s"}`;
}

function getFailedChunkSummary(document: DocumentListItem): string | null {
  if (document.parseStatus !== "failed" || document.chunkCount === null) {
    return null;
  }

  return document.chunkCount > 0
    ? `Failed after ${formatChunkCount(document.chunkCount)}`
    : "Failed with 0 chunks";
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

function DocumentStatusMeta({ document }: DocumentStatusCellProps) {
  return (
    <span className="admin-panel__document-status-meta">
      {getCompactParseProfileLabel(document)}
    </span>
  );
}

function DocumentStatusCell({ document }: DocumentStatusCellProps) {
  const label = getDocumentParseStatusLabel(document.parseStatus);
  const badgeClass = `admin-panel__badge ${STATUS_BADGE_CLASS[document.parseStatus]}`;
  const parsedAtTitle = document.parsedAt
    ? `Parsed ${formatDateTime(document.parsedAt)}`
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
        <DocumentStatusMeta document={document} />
      </div>
    );
  }

  if (document.parseStatus === "failed") {
    const failedChunkSummary = getFailedChunkSummary(document);

    return (
      <div className="admin-panel__document-status-cell">
        <span className={badgeClass}>{label}</span>
        {failedChunkSummary && (
          <span className="admin-panel__document-status-note admin-panel__document-status-note--secondary">
            {failedChunkSummary}
          </span>
        )}
        {document.parseError && (
          <span
            className="admin-panel__document-status-note admin-panel__document-status-note--error"
            title={document.parseError}
          >
            {document.parseError}
          </span>
        )}
        <DocumentStatusMeta document={document} />
      </div>
    );
  }

  return (
    <div className="admin-panel__document-status-cell">
      <span className={badgeClass} title={parsedAtTitle}>
        {label}
      </span>
    </div>
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
  onRequestReparse,
  openingDocumentId,
  deletingDocumentIds,
  reparsingDocumentIds,
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
            <th className="admin-panel__th">Status</th>
            <th className="admin-panel__th admin-panel__th--actions">
              <span className="admin-panel__visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {documents.map((document) => {
            const isSelected = selectedDocumentIds.has(document.id);
            const isDeleting = deletingDocumentIds.has(document.id);
            const isReparsing = reparsingDocumentIds.has(document.id);
            const canView = Boolean(
              document.ragflowDatasetId && document.ragflowDocumentId,
            );
            const fileTitle = document.mimeType
              ? `${document.originalFileName} - ${document.mimeType}`
              : document.originalFileName;
            const shipDisplay = getShipDisplay(document.shipId, shipsById);
            const documentClassLabel = getDocumentClassLabel(document.docClass);
            const documentClassChipLabel = getClassChipLabel(document.docClass);
            const updatedAtLabel = formatCompactDate(document.updatedAt);
            const updatedAtTitle = formatDateTime(document.updatedAt);
            const fileMetaItems = [
              {
                label: `Updated ${updatedAtLabel}`,
                title: updatedAtTitle,
              },
              {
                label: formatChunkCount(document.chunkCount),
              },
            ].filter((item): item is { label: string; title?: string } =>
              Boolean(item.label),
            );

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
                  <div className="admin-panel__document-file-cell">
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
                    <div className="admin-panel__document-file-meta">
                      {fileMetaItems.map((item) => (
                        <span key={item.label} title={item.title}>
                          {item.label}
                        </span>
                      ))}
                      <span className="admin-panel__document-mobile-class">
                        {documentClassChipLabel}
                      </span>
                    </div>
                  </div>
                </td>
                <td className="admin-panel__td admin-panel__td--document-ship">
                  <span className="admin-panel__document-primary-text">
                    {shipDisplay.name}
                  </span>
                </td>
                <td className="admin-panel__td admin-panel__td--document-class">
                  <span
                    className="admin-panel__document-class-pill"
                    title={documentClassLabel}
                  >
                    {documentClassChipLabel}
                  </span>
                </td>
                <td className="admin-panel__td admin-panel__td--status">
                  <DocumentStatusCell document={document} />
                </td>
                <td className="admin-panel__td admin-panel__td--actions">
                  <DocumentRowActions
                    document={document}
                    isDeleting={isDeleting}
                    isReparsing={isReparsing}
                    onRequestDelete={onRequestDelete}
                    onRequestReparse={onRequestReparse}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
