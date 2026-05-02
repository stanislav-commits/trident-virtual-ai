import { useEffect, useMemo, useRef, useState } from "react";
import type {
  DocumentDocClass,
  DocumentListItem,
  DocumentParseStatus,
  ReparseDocumentInput,
} from "../../api/documentsApi";
import {
  bulkDeleteDocuments,
  deleteDocument,
  fetchDocumentFile,
  reparseDocument,
  syncDocumentStatus,
} from "../../api/documentsApi";
import { useAdminShip } from "../../context/AdminShipContext";
import { useAuth } from "../../context/AuthContext";
import { useDocumentsAdminData } from "../../hooks/admin/useDocumentsAdminData";
import { Toast } from "../layout/Toast";
import { DocumentsIcon, UploadIcon } from "./AdminPanelIcons";
import { DocumentDeleteDialog } from "./documents/DocumentDeleteDialog";
import { DocumentReparseDialog } from "./documents/DocumentReparseDialog";
import { DocumentUploadModal } from "./documents/DocumentUploadModal";
import { DocumentsTable } from "./documents/DocumentsTable";
import { getDocumentReparseAction } from "./documents/documentReparseActions";
import {
  DOCUMENT_CLASS_OPTIONS,
  DOCUMENT_PARSE_STATUS_OPTIONS,
} from "./documents/documentOptions";

const ALL_FILTER = "all";
const DOCUMENT_PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = DOCUMENT_PAGE_SIZE_OPTIONS[0];
const ACTIVE_PARSE_STATUSES: DocumentParseStatus[] = [
  "uploaded",
  "pending_config",
  "pending_parse",
  "parsing",
];
const STATUS_SYNC_INTERVAL_MS = 15000;
const MAX_STATUS_SYNC_PER_TICK = 5;
const EMPTY_DOCUMENTS: DocumentListItem[] = [];

interface DocumentFeedback {
  message: string;
  type: "success" | "error" | "info";
}

function getRotatingSyncBatch(
  ids: string[],
  cursor: number,
): { batch: string[]; nextCursor: number } {
  if (ids.length === 0) {
    return { batch: [], nextCursor: 0 };
  }

  const batchSize = Math.min(MAX_STATUS_SYNC_PER_TICK, ids.length);
  const startIndex = cursor % ids.length;
  const batch = Array.from(
    { length: batchSize },
    (_, index) => ids[(startIndex + index) % ids.length],
  );

  return {
    batch,
    nextCursor: (startIndex + batchSize) % ids.length,
  };
}

export function DocumentsSection() {
  const { token } = useAuth();
  const {
    availableShips,
    isLoading: shipsLoading,
    error: shipsError,
  } = useAdminShip();
  const [shipFilter, setShipFilter] = useState<string>(ALL_FILTER);
  const [docClassFilter, setDocClassFilter] = useState<
    DocumentDocClass | typeof ALL_FILTER
  >(ALL_FILTER);
  const [parseStatusFilter, setParseStatusFilter] = useState<
    DocumentParseStatus | typeof ALL_FILTER
  >(ALL_FILTER);
  const [nameSearchInput, setNameSearchInput] = useState("");
  const [nameSearch, setNameSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [deleteTargets, setDeleteTargets] = useState<DocumentListItem[]>([]);
  const [deletingDocumentIds, setDeletingDocumentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [reparsingDocumentIds, setReparsingDocumentIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [reparseTarget, setReparseTarget] = useState<DocumentListItem | null>(
    null,
  );
  const [openingDocumentId, setOpeningDocumentId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<DocumentFeedback | null>(null);
  const statusSyncCursorRef = useRef(0);

  const shipsById = useMemo(
    () => new Map(availableShips.map((ship) => [ship.id, ship])),
    [availableShips],
  );

  const documentsData = useDocumentsAdminData(token, {
    shipId: shipFilter === ALL_FILTER ? undefined : shipFilter,
    docClass: docClassFilter === ALL_FILTER ? undefined : docClassFilter,
    parseStatus:
      parseStatusFilter === ALL_FILTER ? undefined : parseStatusFilter,
    name: nameSearch || undefined,
    page,
    pageSize,
    enabled: Boolean(token),
  });

  const documentsPage = documentsData.documentsPage;
  const documents = documentsPage?.items ?? EMPTY_DOCUMENTS;
  const refreshDocuments = documentsData.refreshDocuments;
  const pagination = documentsPage?.pagination;
  const activePage = pagination?.page ?? page;
  const activePageSize = pagination?.pageSize ?? pageSize;
  const totalDocuments = pagination?.total ?? 0;
  const totalPages = pagination?.totalPages ?? 1;
  const visibleFrom =
    totalDocuments === 0 ? 0 : (activePage - 1) * activePageSize + 1;
  const visibleTo =
    totalDocuments === 0
      ? 0
      : Math.min((activePage - 1) * activePageSize + documents.length, totalDocuments);
  const activeError = documentsData.error || shipsError || "";
  const selectedDocuments = useMemo(
    () => documents.filter((document) => selectedDocumentIds.has(document.id)),
    [documents, selectedDocumentIds],
  );
  const allPageDocumentsSelected =
    documents.length > 0 &&
    documents.every((document) => selectedDocumentIds.has(document.id));
  const activeSyncDocumentIds = useMemo(
    () =>
      documents
        .filter(
          (document) =>
            ACTIVE_PARSE_STATUSES.includes(document.parseStatus) &&
            (document.parseStatus === "uploaded" ||
              document.parseStatus === "pending_config" ||
              (Boolean(document.ragflowDatasetId) &&
                Boolean(document.ragflowDocumentId))),
        )
        .map((document) => document.id),
    [documents],
  );
  const activeSyncKey = activeSyncDocumentIds.join(",");
  const initialUploadShipId =
    shipFilter === ALL_FILTER
      ? availableShips.length === 1
        ? availableShips[0].id
        : undefined
      : shipFilter;

  const resetToFirstPage = () => setPage(1);
  const clearSelectedDocuments = () => setSelectedDocumentIds(new Set());

  const handleUploaded = async () => {
    if (page !== 1) {
      setPage(1);
      clearSelectedDocuments();
      return;
    }

    await refreshDocuments();
  };

  const handleToggleDocumentSelection = (documentId: string) => {
    setSelectedDocumentIds((currentIds) => {
      const nextIds = new Set(currentIds);

      if (nextIds.has(documentId)) {
        nextIds.delete(documentId);
      } else {
        nextIds.add(documentId);
      }

      return nextIds;
    });
  };

  const handleTogglePageSelection = () => {
    setSelectedDocumentIds((currentIds) => {
      if (allPageDocumentsSelected) {
        return new Set();
      }

      const nextIds = new Set(currentIds);
      documents.forEach((document) => nextIds.add(document.id));
      return nextIds;
    });
  };

  const openDocumentInNewTab = async (document: DocumentListItem) => {
    if (!token) {
      setFeedback({ type: "error", message: "Authentication token is missing." });
      return;
    }

    if (!document.ragflowDatasetId || !document.ragflowDocumentId) {
      setFeedback({
        type: "error",
        message: "This document is not available for viewing yet.",
      });
      return;
    }

    const openedWindow = window.open("about:blank", "_blank");

    if (!openedWindow) {
      setFeedback({
        type: "error",
        message: "The browser blocked the document tab.",
      });
      return;
    }

    openedWindow.opener = null;
    setOpeningDocumentId(document.id);

    try {
      const fileBlob = await fetchDocumentFile(token, document.id);
      const fileUrl = URL.createObjectURL(fileBlob);
      openedWindow.location.href = fileUrl;
      window.setTimeout(() => URL.revokeObjectURL(fileUrl), 60000);
    } catch (error) {
      openedWindow.close();
      setFeedback({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to open document.",
      });
    } finally {
      setOpeningDocumentId(null);
    }
  };

  const requestSingleDelete = (document: DocumentListItem) => {
    setDeleteTargets([document]);
  };

  const requestReparse = (document: DocumentListItem) => {
    if (!token) {
      setFeedback({ type: "error", message: "Authentication token is missing." });
      return;
    }

    const reparseAction = getDocumentReparseAction(document);

    if (!reparseAction) {
      setFeedback({
        type: "error",
        message: "This document cannot be reparsed in its current status.",
      });
      return;
    }

    setReparseTarget(document);
  };

  const handleCancelReparse = () => {
    if (!reparseTarget || reparsingDocumentIds.has(reparseTarget.id)) {
      return;
    }

    setReparseTarget(null);
  };

  const handleConfirmReparse = async (input: ReparseDocumentInput) => {
    if (!token || !reparseTarget) {
      return;
    }

    const targetDocument = reparseTarget;
    setReparsingDocumentIds((currentIds) => {
      const nextIds = new Set(currentIds);
      nextIds.add(targetDocument.id);
      return nextIds;
    });
    setFeedback(null);

    try {
      await reparseDocument(token, targetDocument.id, input);
      setFeedback({ type: "success", message: "Reparse queued" });
      setReparseTarget(null);
      await refreshDocuments();
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to queue reparse.",
      });
      setReparseTarget(null);
    } finally {
      setReparsingDocumentIds((currentIds) => {
        const nextIds = new Set(currentIds);
        nextIds.delete(targetDocument.id);
        return nextIds;
      });
    }
  };

  const requestBulkDelete = () => {
    if (selectedDocuments.length > 0) {
      setDeleteTargets(selectedDocuments);
    }
  };

  const handleConfirmDelete = async () => {
    if (!token || deleteTargets.length === 0) {
      return;
    }

    const targetIds = deleteTargets.map((document) => document.id);
    setDeletingDocumentIds(new Set(targetIds));
    setFeedback(null);

    try {
      if (targetIds.length === 1) {
        await deleteDocument(token, targetIds[0]);
        setFeedback({
          type: "success",
          message: "Document deleted.",
        });
      } else {
        const result = await bulkDeleteDocuments(token, targetIds);
        setFeedback({
          type: result.failed > 0 ? "error" : "success",
          message:
            result.failed > 0
              ? `${result.deleted} deleted, ${result.failed} failed.`
              : `${result.deleted} documents deleted.`,
        });
      }

      setDeleteTargets([]);
      setSelectedDocumentIds((currentIds) => {
        const nextIds = new Set(currentIds);
        targetIds.forEach((id) => nextIds.delete(id));
        return nextIds;
      });
      await refreshDocuments();
    } catch (error) {
      setFeedback({
        type: "error",
        message:
          error instanceof Error ? error.message : "Failed to delete document.",
      });
    } finally {
      setDeletingDocumentIds(new Set());
    }
  };

  useEffect(() => {
    const activeIds = activeSyncKey ? activeSyncKey.split(",") : [];

    if (!token || activeIds.length === 0) {
      return undefined;
    }

    const syncVisibleDocuments = async () => {
      const { batch, nextCursor } = getRotatingSyncBatch(
        activeIds,
        statusSyncCursorRef.current,
      );
      statusSyncCursorRef.current = nextCursor;
      let syncedAnyDocument = false;

      for (const documentId of batch) {
        try {
          await syncDocumentStatus(token, documentId);
          syncedAnyDocument = true;
        } catch {
          // Continue syncing the rest of the visible batch so one stale remote
          // document does not starve the other active rows.
        }
      }

      if (syncedAnyDocument) {
        await refreshDocuments();
      }
    };

    const timerId = window.setInterval(() => {
      void syncVisibleDocuments();
    }, STATUS_SYNC_INTERVAL_MS);

    return () => window.clearInterval(timerId);
  }, [activeSyncKey, refreshDocuments, token]);

  useEffect(() => {
    statusSyncCursorRef.current = 0;
  }, [activeSyncKey]);

  useEffect(() => {
    clearSelectedDocuments();
  }, [shipFilter, docClassFilter, parseStatusFilter, nameSearch, page, pageSize]);

  useEffect(() => {
    const trimmed = nameSearchInput.trim();

    if (trimmed === nameSearch) {
      return undefined;
    }

    const timerId = window.setTimeout(() => {
      setNameSearch(trimmed);
      setPage(1);
    }, 300);

    return () => window.clearTimeout(timerId);
  }, [nameSearchInput, nameSearch]);

  return (
    <section className="admin-panel__section">
      <div className="admin-panel__section-head">
        <div className="admin-panel__section-intro">
          <h2 className="admin-panel__section-title">Documents</h2>
          <p className="admin-panel__section-subtitle">
            Manage ship-scoped documents prepared for RAGFlow ingestion.
          </p>
        </div>
        <button
          type="button"
          className="admin-panel__btn admin-panel__btn--primary"
          disabled={!token || shipsLoading || availableShips.length === 0}
          title={
            availableShips.length === 0
              ? "Create a ship before uploading documents"
              : undefined
          }
          onClick={() => setShowUploadModal(true)}
        >
          <UploadIcon /> Upload documents
        </button>
      </div>

      {activeError && (
        <div className="admin-panel__error" role="alert">
          {activeError}
        </div>
      )}

      <div className="admin-panel__form-card admin-panel__documents-filters">
        <div className="admin-panel__form-row">
          <div className="admin-panel__field">
            <label className="admin-panel__field-label" htmlFor="documents-ship">
              Ship
            </label>
            <select
              id="documents-ship"
              className="admin-panel__select"
              value={shipFilter}
              disabled={shipsLoading && availableShips.length === 0}
              onChange={(event) => {
                setShipFilter(event.target.value);
                resetToFirstPage();
              }}
            >
              <option value={ALL_FILTER}>All ships</option>
              {availableShips.map((ship) => (
                <option key={ship.id} value={ship.id}>
                  {ship.organizationName
                    ? `${ship.name} (${ship.organizationName})`
                    : ship.name}
                </option>
              ))}
            </select>
          </div>

          <div className="admin-panel__field">
            <label className="admin-panel__field-label" htmlFor="documents-class">
              Document class
            </label>
            <select
              id="documents-class"
              className="admin-panel__select"
              value={docClassFilter}
              onChange={(event) => {
                setDocClassFilter(
                  event.target.value as DocumentDocClass | typeof ALL_FILTER,
                );
                resetToFirstPage();
              }}
            >
              <option value={ALL_FILTER}>All classes</option>
              {DOCUMENT_CLASS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="admin-panel__field">
            <label className="admin-panel__field-label" htmlFor="documents-status">
              Parse status
            </label>
            <select
              id="documents-status"
              className="admin-panel__select"
              value={parseStatusFilter}
              onChange={(event) => {
                setParseStatusFilter(
                  event.target.value as DocumentParseStatus | typeof ALL_FILTER,
                );
                resetToFirstPage();
              }}
            >
              <option value={ALL_FILTER}>All statuses</option>
              {DOCUMENT_PARSE_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="admin-panel__field">
            <label className="admin-panel__field-label" htmlFor="documents-name">
              Name
            </label>
            <input
              id="documents-name"
              type="search"
              className="admin-panel__input"
              placeholder="Search by document name"
              value={nameSearchInput}
              onChange={(event) => setNameSearchInput(event.target.value)}
            />
          </div>
        </div>
      </div>

      {documentsData.loading && !documentsPage ? (
        <div className="admin-panel__state-box">
          <div className="admin-panel__spinner" />
          <span className="admin-panel__muted">Loading documents...</span>
        </div>
      ) : documents.length === 0 ? (
        <div className="admin-panel__state-box">
          <DocumentsIcon />
          <span className="admin-panel__muted">
            {totalDocuments === 0
              ? "No documents match the current filters."
              : "No documents on this page."}
          </span>
        </div>
      ) : (
        <div className="admin-panel__card admin-panel__documents-card">
          <div className="admin-panel__metrics-toolbar-strip">
            <div className="admin-panel__metrics-toolbar-left">
              <span className="admin-panel__metrics-count">
                Showing {visibleFrom}-{visibleTo} of {totalDocuments}
              </span>
              {documentsData.loading && (
                <span className="admin-panel__muted">Refreshing...</span>
              )}
              {activeSyncDocumentIds.length > 0 && (
                <span className="admin-panel__documents-sync-note">
                  Tracking {activeSyncDocumentIds.length} active parse
                  {activeSyncDocumentIds.length === 1 ? "" : "s"}
                </span>
              )}
            </div>

            <div className="admin-panel__metrics-pager">
              <div className="admin-panel__metrics-pager-size">
                <span className="admin-panel__metrics-pager-label">Rows</span>
                <select
                  className="admin-panel__select admin-panel__select--compact"
                  value={String(pageSize)}
                  disabled={documentsData.loading}
                  onChange={(event) => {
                    setPageSize(Number(event.target.value));
                    resetToFirstPage();
                  }}
                >
                  {DOCUMENT_PAGE_SIZE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>

              <div className="admin-panel__metrics-pager-nav">
                <button
                  type="button"
                  className="admin-panel__metrics-pager-btn"
                  aria-label="Previous page"
                  disabled={documentsData.loading || activePage <= 1}
                  onClick={() => setPage(Math.max(1, activePage - 1))}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                </button>
                <span className="admin-panel__metrics-pager-indicator">
                  {activePage} / {totalPages}
                </span>
                <button
                  type="button"
                  className="admin-panel__metrics-pager-btn"
                  aria-label="Next page"
                  disabled={documentsData.loading || activePage >= totalPages}
                  onClick={() => setPage(Math.min(totalPages, activePage + 1))}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                </button>
              </div>
            </div>
          </div>

          {selectedDocuments.length > 0 && (
            <div className="admin-panel__documents-bulk-bar">
              <span className="admin-panel__documents-bulk-copy">
                {selectedDocuments.length} selected
              </span>
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--danger admin-panel__btn--compact"
                disabled={deletingDocumentIds.size > 0}
                onClick={requestBulkDelete}
              >
                Delete selected
              </button>
            </div>
          )}

          <DocumentsTable
            documents={documents}
            shipsById={shipsById}
            selectedDocumentIds={selectedDocumentIds}
            allPageDocumentsSelected={allPageDocumentsSelected}
            onTogglePageSelection={handleTogglePageSelection}
            onToggleDocumentSelection={handleToggleDocumentSelection}
            onViewDocument={openDocumentInNewTab}
            onRequestDelete={requestSingleDelete}
            onRequestReparse={requestReparse}
            openingDocumentId={openingDocumentId}
            deletingDocumentIds={deletingDocumentIds}
            reparsingDocumentIds={reparsingDocumentIds}
          />
        </div>
      )}

      {showUploadModal && (
        <DocumentUploadModal
          token={token}
          ships={availableShips}
          initialShipId={initialUploadShipId}
          onClose={() => setShowUploadModal(false)}
          onUploaded={handleUploaded}
        />
      )}

      {deleteTargets.length > 0 && (
        <DocumentDeleteDialog
          documents={deleteTargets}
          deleting={deletingDocumentIds.size > 0}
          onCancel={() => setDeleteTargets([])}
          onConfirm={() => void handleConfirmDelete()}
        />
      )}

      {reparseTarget && (
        <DocumentReparseDialog
          key={reparseTarget.id}
          document={reparseTarget}
          reparsing={reparsingDocumentIds.has(reparseTarget.id)}
          onCancel={handleCancelReparse}
          onConfirm={(input) => void handleConfirmReparse(input)}
        />
      )}

      <Toast
        message={feedback?.message ?? ""}
        type={feedback?.type ?? "info"}
        duration={5000}
        onClose={() => setFeedback(null)}
      />
    </section>
  );
}
