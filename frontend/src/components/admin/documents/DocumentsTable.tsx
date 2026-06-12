import { useRef, useState } from "react";
import {
  fetchExtractedMarkdown,
  rerunExtraction,
} from "../../../api/documentsApi";
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
  getDocumentRoleLabel,
} from "./documentOptions";

interface DocumentsTableProps {
  token: string | null;
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
  onRequestMetadataEdit: (document: DocumentListItem) => void;
  onRequestDelete: (document: DocumentListItem) => void;
  onRequestReparse: (document: DocumentListItem) => void;
  onPriorityChange: (documentId: string, nextPriority: number) => void;
  onPriorityValidationError: (message: string) => void;
  openingDocumentId: string | null;
  deletingDocumentIds: Set<string>;
  reparsingDocumentIds: Set<string>;
  updatingMetadataDocumentIds: Set<string>;
  updatingPriorityDocumentIds: Set<string>;
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
const SOURCE_PRIORITY_ERROR =
  "Source priority must be a whole number from 0 to 1000.";

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
    return "Maintenance";
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

interface DocumentPriorityControlProps {
  document: DocumentListItem;
  disabled: boolean;
  saving: boolean;
  onPriorityChange: (documentId: string, nextPriority: number) => void;
  onPriorityValidationError: (message: string) => void;
}

function DocumentPriorityControl({
  document,
  disabled,
  saving,
  onPriorityChange,
  onPriorityValidationError,
}: DocumentPriorityControlProps) {
  const currentPriority = document.sourcePriority ?? 100;
  const [draftValue, setDraftValue] = useState(String(currentPriority));
  const skipNextBlurCommitRef = useRef(false);

  const resetDraftValue = () => {
    setDraftValue(String(currentPriority));
  };

  const commitValue = (value: string) => {
    if (skipNextBlurCommitRef.current) {
      skipNextBlurCommitRef.current = false;
      resetDraftValue();
      return;
    }

    const normalized = value.trim();
    const parsedPriority = Number(normalized);

    if (
      !normalized ||
      !Number.isInteger(parsedPriority) ||
      parsedPriority < 0 ||
      parsedPriority > 1000
    ) {
      onPriorityValidationError(SOURCE_PRIORITY_ERROR);
      resetDraftValue();
      return;
    }

    if (parsedPriority === currentPriority) {
      resetDraftValue();
      return;
    }

    onPriorityChange(document.id, parsedPriority);
    resetDraftValue();
  };

  return (
    <span className="admin-panel__document-priority-control">
      <label
        className="admin-panel__document-priority-field"
        title="Lower number means higher priority"
      >
        <span className="admin-panel__visually-hidden">Priority</span>
        <input
          className="admin-panel__document-priority-input"
          type="number"
          min="0"
          max="1000"
          step="1"
          value={draftValue}
          disabled={disabled || saving}
          aria-label={`Source priority for ${document.originalFileName}`}
          onChange={(event) => setDraftValue(event.target.value)}
          onBlur={(event) => commitValue(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }

            if (event.key === "Escape") {
              event.preventDefault();
              skipNextBlurCommitRef.current = true;
              resetDraftValue();
              event.currentTarget.blur();
            }
          }}
        />
      </label>
    </span>
  );
}

export function DocumentsTable({
  token,
  documents,
  shipsById,
  selectedDocumentIds,
  allPageDocumentsSelected,
  onTogglePageSelection,
  onToggleDocumentSelection,
  onViewDocument,
  onRequestMetadataEdit,
  onRequestDelete,
  onRequestReparse,
  onPriorityChange,
  onPriorityValidationError,
  openingDocumentId,
  deletingDocumentIds,
  reparsingDocumentIds,
  updatingMetadataDocumentIds,
  updatingPriorityDocumentIds,
}: DocumentsTableProps) {
  return (
    <div className="admin-panel__table-wrap admin-panel__documents-table-wrap">
      <table className="admin-panel__table admin-panel__table--documents">
        <colgroup>
          <col className="admin-panel__documents-col--select" />
          <col className="admin-panel__documents-col--file" />
          <col className="admin-panel__documents-col--ship" />
          <col className="admin-panel__documents-col--class" />
          <col className="admin-panel__documents-col--priority" />
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
            <th className="admin-panel__th">Priority</th>
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
            const isUpdatingMetadata = updatingMetadataDocumentIds.has(document.id);
            const isUpdatingPriority = updatingPriorityDocumentIds.has(document.id);
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
                <td className="admin-panel__td admin-panel__td--document-priority">
                  <DocumentPriorityControl
                    key={`${document.id}:${document.sourcePriority}`}
                    document={document}
                    disabled={isDeleting || isReparsing}
                    saving={isUpdatingPriority}
                    onPriorityChange={onPriorityChange}
                    onPriorityValidationError={onPriorityValidationError}
                  />
                </td>
                <td className="admin-panel__td admin-panel__td--status">
                  <DocumentStatusCell document={document} token={token} />
                </td>
                <td className="admin-panel__td admin-panel__td--actions">
                  <DocumentRowActions
                    document={document}
                    isDeleting={isDeleting}
                    isReparsing={isReparsing}
                    isUpdatingMetadata={isUpdatingMetadata}
                    onRequestMetadataEdit={onRequestMetadataEdit}
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
