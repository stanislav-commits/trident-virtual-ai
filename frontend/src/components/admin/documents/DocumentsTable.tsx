import {
  fetchExtractedMarkdown,
  rerunExtraction,
} from "../../../api/documentsApi";
import type {
  DocumentListItem,
  DocumentParseStatus,
} from "../../../api/documentsApi";
import { DocumentRowActions } from "./DocumentRowActions";
import {
  DOCUMENT_PARSE_STATUS_OPTIONS,
  getDocumentParseProfileLabel,
  getDocumentParseStatusLabel,
  getDocumentRoleLabel,
} from "./documentOptions";

interface DocumentsTableProps {
  token: string | null;
  documents: DocumentListItem[];
  selectedDocumentIds: Set<string>;
  allPageDocumentsSelected: boolean;
  parseStatusFilter: DocumentParseStatus | "all";
  onParseStatusFilterChange: (value: DocumentParseStatus | "all") => void;
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

function getCompactParseProfileLabel(document: DocumentListItem): string {
  return getDocumentParseProfileLabel(document.parseProfile).replace(
    /\s+profile$/i,
    "",
  );
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

/**
 * Vision-extraction chip. done → click opens the extracted markdown in a
 * new tab (admin-only endpoint); failed → click re-queues extraction.
 */
function ExtractionChip({
  document,
  token,
}: {
  document: DocumentListItem;
  token: string | null;
}) {
  const status = document.extractionStatus ?? "none";
  if (status === "none") return null;
  const cls =
    status === "done"
      ? "admin-panel__badge admin-panel__badge--success"
      : status === "failed"
        ? "admin-panel__badge admin-panel__badge--danger"
        : "admin-panel__badge";

  const onClick = async () => {
    if (!token) return;
    if (status === "done") {
      const { markdown } = await fetchExtractedMarkdown(token, document.id);
      const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/plain;charset=utf-8" }),
      );
      window.open(url, "_blank");
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } else if (status === "failed") {
      await rerunExtraction(token, document.id);
    }
  };

  return (
    <button
      type="button"
      className={cls}
      style={{ cursor: status === "done" || status === "failed" ? "pointer" : "default", border: 0 }}
      title={
        status === "done"
          ? "Vision extract attached — click to view the markdown (admin only)"
          : status === "failed"
            ? `Extraction failed — click to re-run`
            : `Vision extraction: ${status}`
      }
      onClick={() => void onClick()}
    >
      MD {status}
    </button>
  );
}

function DocumentStatusCell({ document, token }: DocumentStatusCellProps & { token: string | null }) {
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
          <ExtractionChip document={document} token={token} />
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
          <ExtractionChip document={document} token={token} />
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
      <div className="admin-panel__document-status-row">
        <span className={badgeClass} title={parsedAtTitle}>
          {label}
        </span>
        <ExtractionChip document={document} token={token} />
      </div>
    </div>
  );
}

export function DocumentsTable({
  token,
  documents,
  selectedDocumentIds,
  allPageDocumentsSelected,
  parseStatusFilter,
  onParseStatusFilterChange,
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
            <th className="admin-panel__th">
              <select
                className="admin-panel__th-filter"
                value={parseStatusFilter}
                onChange={(event) =>
                  onParseStatusFilterChange(
                    event.target.value as DocumentParseStatus | "all",
                  )
                }
                aria-label="Filter by parse status"
              >
                <option value="all">Status</option>
                {DOCUMENT_PARSE_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </th>
            <th className="admin-panel__th admin-panel__th--actions">
              <span className="admin-panel__visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {/* Keep the table (and the status filter in its header) rendered
              even with zero matches — otherwise picking a status that has no
              documents made the filter itself disappear. */}
          {documents.length === 0 && (
            <tr>
              <td colSpan={4} className="admin-panel__td inv__empty-cell">
                No documents match the current filters.
              </td>
            </tr>
          )}
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
            const equipmentModel = [document.manufacturer, document.model]
              .filter(Boolean)
              .join(" ");
            const rawMetadataMetaItems: Array<{
              label: string;
              title: string;
            } | null> = [
              document.documentRole
                ? {
                    label: getDocumentRoleLabel(document.documentRole),
                    title: "Document role",
                  }
                : null,
              document.equipmentName
                ? {
                    label: document.equipmentName,
                    title: document.equipmentAliases ?? "Equipment name",
                  }
                : null,
              equipmentModel
                ? {
                    label: equipmentModel,
                    title: "Manufacturer and model",
                  }
                : null,
              document.systemArea
                ? {
                    label: document.systemArea,
                    title: "System/Area",
                  }
                : null,
              document.linkedAssets?.length
                ? {
                    label: `🔗 ${document.linkedAssets
                      .slice(0, 2)
                      .join(", ")}${
                      document.linkedAssets.length > 2
                        ? ` +${document.linkedAssets.length - 2}`
                        : ""
                    }`,
                    title: `Linked assets:\n${document.linkedAssets.join("\n")}`,
                  }
                : null,
            ];
            const metadataMetaItems = rawMetadataMetaItems.filter(
              (item): item is { label: string; title: string } => item !== null,
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
                        {document.originalFileName.replace(/^\[UNLINKED\]\s*/i, "")}
                      </span>
                    </button>
                    {!document.linkedAssets?.length && (
                      <span
                        className="admin-panel__doc-unlinked"
                        title="Not linked to any asset yet — link it from an asset's Manuals tab"
                      >
                        Unlinked
                      </span>
                    )}
                    <div className="admin-panel__document-file-meta">
                      {fileMetaItems.map((item) => (
                        <span key={item.label} title={item.title}>
                          {item.label}
                        </span>
                      ))}
                    </div>
                    {metadataMetaItems.length > 0 && (
                      <div className="admin-panel__document-metadata-meta">
                        {metadataMetaItems.map((item) => (
                          <span key={item.label} title={item.title}>
                            {item.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </td>
                <td className="admin-panel__td admin-panel__td--status">
                  <DocumentStatusCell document={document} token={token} />
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
