import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  uploadManual,
  deleteManual,
  bulkDeleteManuals,
  getManualTags,
  replaceManualTags,
  updateManual,
  getManualsStatus,
  fetchWithAuth,
  type ManualStatusItem,
  type PaginationMeta,
  type ShipManualCategory,
} from "../../api/client";
import { SearchIcon, ShipIcon, XIcon } from "./AdminPanelIcons";
import {
  DEFAULT_KNOWLEDGE_BASE_CATEGORY,
  KNOWLEDGE_BASE_CATEGORIES,
  getKnowledgeBaseCategoryConfig,
  type KnowledgeBaseCategory,
} from "./knowledge-base";
import { TagLinksEditorModal } from "./TagLinksEditorModal";

const MANUALS_PAGE_SIZE_OPTIONS = [25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;

const EMPTY_PAGINATION: PaginationMeta = {
  page: 1,
  pageSize: DEFAULT_PAGE_SIZE,
  total: 0,
  totalPages: 1,
  hasNextPage: false,
  hasPreviousPage: false,
};

function ManualStatusBadge({
  run,
  progress,
  chunkCount,
}: {
  run: string | null;
  progress: number | null;
  chunkCount: number | null;
}) {
  if (run === null) {
    return (
      <span className="admin-panel__badge admin-panel__badge--manual-unknown">
        -
      </span>
    );
  }

  switch (run) {
    case "DONE":
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-done">
          Done{chunkCount != null ? ` (${chunkCount} chunks)` : ""}
        </span>
      );
    case "RUNNING":
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-running">
          Indexing{progress != null ? ` ${Math.round(progress * 100)}%` : "..."}
        </span>
      );
    case "UNSTART":
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-pending">
          Pending
        </span>
      );
    case "FAIL":
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-fail">
          Failed
        </span>
      );
    case "CANCEL":
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-cancel">
          Cancelled
        </span>
      );
    default:
      return (
        <span className="admin-panel__badge admin-panel__badge--manual-unknown">
          {run}
        </span>
      );
  }
}

function SelectionCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!inputRef.current) return;
    inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={inputRef}
      type="checkbox"
      className="admin-panel__selection-check"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

interface ManualsPromptModalProps {
  token: string | null;
  shipId: string;
  shipName: string;
  onClose: () => void;
  onError: (error: string) => void;
}

export function ManualsPromptModal({
  token,
  shipId,
  shipName,
  onClose,
  onError,
}: ManualsPromptModalProps) {
  const [activeCategory, setActiveCategory] = useState<KnowledgeBaseCategory>(
    DEFAULT_KNOWLEDGE_BASE_CATEGORY,
  );
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const latestLoadRequestRef = useRef(0);
  const [editingManualId, setEditingManualId] = useState<string | null>(null);
  const [editingFilename, setEditingFilename] = useState("");
  const [deletingManualId, setDeletingManualId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [tagEditingManual, setTagEditingManual] = useState<ManualStatusItem | null>(
    null,
  );
  const [manuals, setManuals] = useState<ManualStatusItem[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta>(EMPTY_PAGINATION);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedSearchQuery, setAppliedSearchQuery] = useState("");
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [allManualsSelected, setAllManualsSelected] = useState(false);
  const [selectedManualIds, setSelectedManualIds] = useState<string[]>([]);
  const [excludedManualIds, setExcludedManualIds] = useState<string[]>([]);
  const deferredSearchQuery = useDeferredValue(searchQuery.trim());

  const hasNonTerminal = useMemo(
    () =>
      manuals.some(
        (manual) =>
          manual.run !== null &&
          manual.run !== "DONE" &&
          manual.run !== "FAIL" &&
          manual.run !== "CANCEL",
      ),
    [manuals],
  );

  const selectedManualIdSet = useMemo(
    () => new Set(selectedManualIds),
    [selectedManualIds],
  );
  const excludedManualIdSet = useMemo(
    () => new Set(excludedManualIds),
    [excludedManualIds],
  );
  const activeCategoryConfig = useMemo(
    () => getKnowledgeBaseCategoryConfig(activeCategory),
    [activeCategory],
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setAppliedSearchQuery(deferredSearchQuery);
    }, 220);

    return () => window.clearTimeout(timeoutId);
  }, [deferredSearchQuery]);

  const loadManualsPage = useCallback(
    async (
      category: KnowledgeBaseCategory,
      targetPage: number,
      targetPageSize: number,
      options?: { silent?: boolean; search?: string },
    ) => {
      if (!token) return;
      const requestId = latestLoadRequestRef.current + 1;
      latestLoadRequestRef.current = requestId;

      if (!options?.silent) {
        setLoading(true);
      }

      try {
        const result = await getManualsStatus(shipId, token, {
          page: targetPage,
          pageSize: targetPageSize,
          category,
          search: options?.search,
        });
        if (requestId !== latestLoadRequestRef.current) {
          return;
        }
        setManuals(result.items);
        setPagination(result.pagination);
        setPage(result.pagination.page);
        setPageSize(result.pagination.pageSize);
      } catch (err) {
        if (!options?.silent && requestId === latestLoadRequestRef.current) {
          onError(
            err instanceof Error
              ? err.message
              : "Failed to fetch knowledge base files",
          );
        }
      } finally {
        if (!options?.silent && requestId === latestLoadRequestRef.current) {
          setLoading(false);
        }
      }
    },
    [onError, shipId, token],
  );

  useEffect(() => {
    if (!token) return;
    onError("");
    setAllManualsSelected(false);
    setSelectedManualIds([]);
    setExcludedManualIds([]);
    setEditingManualId(null);
    setEditingFilename("");
    setConfirmDeleteId(null);
    setConfirmBulkDelete(false);
    void loadManualsPage(activeCategory, 1, pageSize, {
      search: appliedSearchQuery,
    });
  }, [activeCategory, appliedSearchQuery, loadManualsPage, onError, pageSize, token]);

  useEffect(() => {
    if (!token || !manuals.length || !hasNonTerminal) return;

    const intervalId = window.setInterval(() => {
      void loadManualsPage(activeCategory, page, pageSize, {
        silent: true,
        search: appliedSearchQuery,
      });
    }, 5000);

    return () => window.clearInterval(intervalId);
  }, [
    activeCategory,
    hasNonTerminal,
    loadManualsPage,
    manuals.length,
    page,
    pageSize,
    appliedSearchQuery,
    token,
  ]);

  const clearSelection = useCallback(() => {
    setAllManualsSelected(false);
    setSelectedManualIds([]);
    setExcludedManualIds([]);
  }, []);

  const resetInteractionState = useCallback(() => {
    clearSelection();
    setSelectedFiles([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setEditingManualId(null);
    setEditingFilename("");
    setDeletingManualId(null);
    setConfirmDeleteId(null);
    setConfirmBulkDelete(false);
  }, [clearSelection]);

  const handleCategoryChange = useCallback(
    (nextCategory: KnowledgeBaseCategory) => {
      if (nextCategory === activeCategory) {
        return;
      }
      onError("");
      resetInteractionState();
      setManuals([]);
      setPagination(EMPTY_PAGINATION);
      setPage(1);
      setLoading(true);
      setActiveCategory(nextCategory);
    },
    [activeCategory, onError, resetInteractionState],
  );

  const isManualSelected = useCallback(
    (manualId: string) =>
      allManualsSelected
        ? !excludedManualIdSet.has(manualId)
        : selectedManualIdSet.has(manualId),
    [allManualsSelected, excludedManualIdSet, selectedManualIdSet],
  );

  const toggleAllManualsSelection = useCallback((checked: boolean) => {
    if (checked) {
      setAllManualsSelected(true);
      setSelectedManualIds([]);
      setExcludedManualIds([]);
      return;
    }

    setAllManualsSelected(false);
    setSelectedManualIds([]);
    setExcludedManualIds([]);
  }, []);

  const toggleManualSelection = useCallback(
    (manualId: string, checked: boolean) => {
      if (allManualsSelected) {
        setExcludedManualIds((current) => {
          const next = checked
            ? current.filter((id) => id !== manualId)
            : [...new Set([...current, manualId])];

          if (pagination.total - next.length <= 0) {
            setAllManualsSelected(false);
            setSelectedManualIds([]);
            return [];
          }

          return next;
        });
        return;
      }

      setSelectedManualIds((current) =>
        checked
          ? [...new Set([...current, manualId])]
          : current.filter((id) => id !== manualId),
      );
    },
    [allManualsSelected, pagination.total],
  );

  const handleUploadManual = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!token) return;

    const files =
      selectedFiles.length > 0
        ? selectedFiles
        : fileInputRef.current?.files
          ? Array.from(fileInputRef.current.files)
          : [];

    if (files.length === 0) return;

    setUploading(true);
    onError("");

    try {
      for (const file of files) {
        await uploadManual(shipId, file, token, activeCategory as ShipManualCategory);
      }

      resetInteractionState();
      await loadManualsPage(activeCategory, 1, pageSize, {
        search: appliedSearchQuery,
      });
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Failed to upload knowledge base file",
      );
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (manualId: string) => {
    if (!token) return;

    setDeletingManualId(manualId);
    onError("");

    try {
      await deleteManual(shipId, manualId, token);
      setSelectedManualIds((current) => current.filter((id) => id !== manualId));
      setExcludedManualIds((current) => current.filter((id) => id !== manualId));
      const fallbackPage = manuals.length === 1 && page > 1 ? page - 1 : page;
      await loadManualsPage(activeCategory, fallbackPage, pageSize, {
        search: appliedSearchQuery,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete file");
    } finally {
      setDeletingManualId(null);
    }
  };

  const handleBulkDelete = async () => {
    if (!token) return;

    setBulkDeleting(true);
    onError("");

    try {
      await bulkDeleteManuals(
        shipId,
        allManualsSelected
          ? {
              mode: "all",
              category: activeCategory as ShipManualCategory,
              excludeManualIds: excludedManualIds,
              search: appliedSearchQuery || undefined,
            }
          : {
              mode: "manualIds",
              category: activeCategory as ShipManualCategory,
              manualIds: selectedManualIds,
            },
        token,
      );
      clearSelection();
      await loadManualsPage(activeCategory, page, pageSize, {
        search: appliedSearchQuery,
      });
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Failed to delete selected files",
      );
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleEditSave = async (manualId: string) => {
    if (!token) return;

    onError("");

    try {
      await updateManual(
        shipId,
        manualId,
        { filename: editingFilename },
        token,
      );
      setEditingManualId(null);
      setEditingFilename("");
      await loadManualsPage(activeCategory, page, pageSize, {
        silent: true,
        search: appliedSearchQuery,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to update file");
    }
  };

  const showingFrom = pagination.total === 0 ? 0 : (page - 1) * pageSize + 1;
  const showingTo =
    pagination.total === 0 ? 0 : Math.min(page * pageSize, pagination.total);
  const hasMultiplePages = pagination.totalPages > 1;
  const showPageSizeControl =
    pagination.total > DEFAULT_PAGE_SIZE || hasMultiplePages;
  const hasSelectedFiles = selectedFiles.length > 0;
  const selectedManualCount = allManualsSelected
    ? Math.max(0, pagination.total - excludedManualIds.length)
    : selectedManualIds.length;
  const headerCheckboxChecked =
    pagination.total > 0 &&
    allManualsSelected &&
    excludedManualIds.length === 0;
  const headerCheckboxIndeterminate =
    selectedManualCount > 0 && !headerCheckboxChecked;
  const isSearching = appliedSearchQuery.length > 0;
  const totalFilesLabel = `${pagination.total.toLocaleString()} ${
    isSearching ? "matching " : ""
  }file${pagination.total === 1 ? "" : "s"}`;
  const selectionSummary =
    allManualsSelected && excludedManualIds.length === 0
      ? `All ${pagination.total.toLocaleString()}${
          isSearching ? " matching" : ""
        } files selected`
      : `${selectedManualCount.toLocaleString()} selected`;
  const resultsSummary = isSearching
    ? `Showing ${showingFrom}-${showingTo} of ${pagination.total.toLocaleString()} matching ${activeCategoryConfig.rowLabel}`
    : `Showing ${showingFrom}-${showingTo} of ${pagination.total.toLocaleString()} in ${activeCategoryConfig.folderLabel}`;
  const emptyStateMessage = isSearching
    ? `No ${activeCategoryConfig.rowLabel} found for "${appliedSearchQuery}".`
    : activeCategoryConfig.emptyState;

  return (
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ap-manuals-prompt-title"
    >
      <div className="admin-panel__modal admin-panel__modal--wide admin-panel__modal--manuals">
        <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
          <ShipIcon />
        </div>
        <h2 id="ap-manuals-prompt-title" className="admin-panel__modal-title">
          Knowledge Base for "{shipName}"
        </h2>
        <p className="admin-panel__modal-desc">
          Manage ship files by category. All folders stay in the same ship
          dataset and are used by RAG plus the chat assistant.
        </p>

        <div className="admin-panel__modal-body admin-panel__manuals-body">
          <div className="admin-panel__knowledge-base-tabs-sticky">
            <div className="admin-panel__knowledge-base-nav">
              <div
                className="admin-panel__knowledge-base-tabs"
                role="tablist"
                aria-label="Knowledge base categories"
              >
                {KNOWLEDGE_BASE_CATEGORIES.map((category) => {
                  const isActive = activeCategory === category.id;
                  return (
                    <button
                      key={category.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      className={`admin-panel__knowledge-base-tab${
                        isActive
                          ? " admin-panel__knowledge-base-tab--active"
                          : ""
                      }`}
                      onClick={() => handleCategoryChange(category.id)}
                    >
                      <span className="admin-panel__knowledge-base-tab-label">
                        {category.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              <label className="admin-panel__knowledge-base-search">
                <SearchIcon />
                <input
                  type="search"
                  className="admin-panel__knowledge-base-search-input"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={`Search ${activeCategoryConfig.folderLabel}`}
                  aria-label={`Search ${activeCategoryConfig.folderLabel}`}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
            </div>
          </div>

          <form onSubmit={handleUploadManual} className="admin-panel__manuals-upload">
            <div className="admin-panel__manuals-upload-head">
              <div className="admin-panel__knowledge-base-upload-head">
                <span className="admin-panel__field-label">
                  {activeCategoryConfig.uploadHeading}
                </span>
                <span className="admin-panel__knowledge-base-extensions">
                  {activeCategoryConfig.acceptedExtensionsLabel}
                </span>
              </div>
              <p className="admin-panel__manuals-upload-hint">
                {activeCategoryConfig.description}
              </p>
            </div>

            <div className="admin-panel__manuals-upload-controls">
              <div className="admin-panel__manuals-upload-picker">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={activeCategoryConfig.accept}
                  className="admin-panel__file-input"
                  multiple
                  disabled={uploading}
                  onChange={(e) => {
                    const list = e.target.files
                      ? Array.from(e.target.files)
                      : [];
                    setSelectedFiles(list);
                  }}
                />
                <button
                  type="button"
                  className="admin-panel__file-trigger admin-panel__file-trigger--manuals"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                >
                  {hasSelectedFiles ? "Change files" : "Select files"}
                </button>
              </div>

              <div className="admin-panel__manuals-upload-summary">
                <span className="admin-panel__manuals-upload-summary-title">
                  {hasSelectedFiles
                    ? `${selectedFiles.length} file(s) ready`
                    : "No files selected yet"}
                </span>
                <span className="admin-panel__manuals-upload-summary-meta">
                  {hasSelectedFiles
                    ? "Upload will start indexing after the files are attached."
                    : `${activeCategoryConfig.acceptedExtensionsLabel} supported.`}
                </span>
              </div>

              <button
                type="submit"
                className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--manual-upload"
                disabled={uploading || selectedFiles.length === 0}
              >
                {uploading ? "Uploading..." : "Upload"}
              </button>
            </div>

            {hasSelectedFiles && (
              <div className="admin-panel__manuals-upload-files">
                {selectedFiles.map((file, index) => (
                  <span
                    key={`${file.name}-${index}`}
                    className="admin-panel__manuals-upload-file"
                  >
                    {file.name}
                  </span>
                ))}
              </div>
            )}
          </form>

          {loading ? (
            <div className="admin-panel__state-box admin-panel__manuals-state">
              <div className="admin-panel__spinner" />
              <span className="admin-panel__muted">Loading...</span>
            </div>
          ) : manuals.length > 0 ? (
            <div className="admin-panel__manuals-list-card">
              <div className="admin-panel__manuals-toolbar">
                <div className="admin-panel__manuals-toolbar-copy">
                  <span className="admin-panel__manuals-toolbar-title">
                    {totalFilesLabel}
                  </span>
                  <div className="admin-panel__manuals-toolbar-meta">
                    <span className="admin-panel__muted">{resultsSummary}</span>
                    {selectedManualCount > 0 && (
                      <span className="admin-panel__manuals-selection-summary">
                        {selectionSummary}
                      </span>
                    )}
                  </div>
                </div>

                <div className="admin-panel__manuals-toolbar-actions">
                  {(showPageSizeControl || hasMultiplePages) && (
                    <div className="admin-panel__manuals-pager">
                      {showPageSizeControl && (
                        <label className="admin-panel__manuals-page-size">
                          <span className="admin-panel__manuals-page-size-label">
                            Rows
                          </span>
                          <select
                            className="admin-panel__select admin-panel__select--compact"
                            value={pageSize}
                            onChange={(event) => {
                              const nextPageSize = Number.parseInt(
                                event.target.value,
                                10,
                              );
                              setPageSize(nextPageSize);
                            }}
                          >
                            {MANUALS_PAGE_SIZE_OPTIONS.map((size) => (
                              <option key={size} value={size}>
                                {size} / page
                              </option>
                            ))}
                          </select>
                        </label>
                      )}

                      {hasMultiplePages && (
                        <>
                          <button
                            type="button"
                            className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                            onClick={() =>
                              void loadManualsPage(activeCategory, page - 1, pageSize, {
                                search: appliedSearchQuery,
                              })
                            }
                            disabled={!pagination.hasPreviousPage}
                          >
                            Prev
                          </button>
                          <span className="admin-panel__manuals-page-indicator">
                            Page {page} / {pagination.totalPages}
                          </span>
                          <button
                            type="button"
                            className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                            onClick={() =>
                              void loadManualsPage(activeCategory, page + 1, pageSize, {
                                search: appliedSearchQuery,
                              })
                            }
                            disabled={!pagination.hasNextPage}
                          >
                            Next
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--danger admin-panel__btn--compact"
                    onClick={() => setConfirmBulkDelete(true)}
                    disabled={
                      selectedManualCount === 0 ||
                      bulkDeleting ||
                      deletingManualId !== null
                    }
                  >
                    {bulkDeleting ? "Deleting..." : "Delete selected"}
                  </button>
                </div>
              </div>

              <div className="admin-panel__manuals-table-wrap">
                <table className="admin-panel__table admin-panel__table--manuals">
                  <colgroup>
                    <col className="admin-panel__manuals-col admin-panel__manuals-col--select" />
                    <col className="admin-panel__manuals-col admin-panel__manuals-col--name" />
                    <col className="admin-panel__manuals-col admin-panel__manuals-col--status" />
                    <col className="admin-panel__manuals-col admin-panel__manuals-col--uploaded" />
                    <col className="admin-panel__manuals-col admin-panel__manuals-col--actions" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="admin-panel__th admin-panel__th--select">
                        <SelectionCheckbox
                          checked={headerCheckboxChecked}
                          indeterminate={headerCheckboxIndeterminate}
                          disabled={pagination.total === 0 || bulkDeleting}
                          ariaLabel={`Select all files in ${activeCategoryConfig.folderLabel}`}
                          onChange={toggleAllManualsSelection}
                        />
                      </th>
                      <th className="admin-panel__th">Filename</th>
                      <th className="admin-panel__th">Status</th>
                      <th className="admin-panel__th">Uploaded</th>
                      <th className="admin-panel__th admin-panel__th--actions">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {manuals.map((manual) => (
                      <tr key={manual.id} className="admin-panel__row">
                        <td className="admin-panel__td admin-panel__td--select">
                          <SelectionCheckbox
                            checked={isManualSelected(manual.id)}
                            disabled={bulkDeleting}
                            ariaLabel={`Select ${manual.filename}`}
                            onChange={(checked) =>
                              toggleManualSelection(manual.id, checked)
                            }
                          />
                        </td>
                        <td className="admin-panel__td admin-panel__td--manual-name">
                          {editingManualId === manual.id ? (
                            <input
                              className="admin-panel__input admin-panel__input--full"
                              value={editingFilename}
                              onChange={(e) => setEditingFilename(e.target.value)}
                            />
                          ) : (
                            <span className="admin-panel__manual-name-text">
                              {manual.filename}
                            </span>
                          )}
                        </td>
                        <td className="admin-panel__td admin-panel__td--manual-status">
                          <ManualStatusBadge
                            run={manual.run}
                            progress={manual.progress}
                            chunkCount={manual.chunkCount}
                          />
                        </td>
                        <td className="admin-panel__td admin-panel__td--muted admin-panel__td--manual-date">
                          {new Date(manual.uploadedAt).toLocaleDateString()}
                        </td>
                        <td className="admin-panel__td admin-panel__td--manual-actions">
                          <div className="admin-panel__actions admin-panel__actions--manuals">
                            <button
                              type="button"
                              className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                              onClick={async () => {
                                if (!token) return;
                                try {
                                  const res = await fetchWithAuth(
                                    `ships/${shipId}/manuals/${manual.id}/download`,
                                    { token },
                                  );
                                  if (!res.ok) {
                                    throw new Error("Download failed");
                                  }
                                  const blob = await res.blob();
                                  const url = URL.createObjectURL(blob);
                                  window.open(url, "_blank");
                                  setTimeout(() => URL.revokeObjectURL(url), 60000);
                                } catch (err) {
                                  onError(
                                    err instanceof Error
                                      ? err.message
                                      : "Failed to view file",
                                  );
                                }
                              }}
                            >
                              View
                            </button>

                            {editingManualId === manual.id ? (
                              <>
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--compact"
                                  onClick={() => void handleEditSave(manual.id)}
                                  disabled={!editingFilename.trim()}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                                  onClick={() => {
                                    setEditingManualId(null);
                                    setEditingFilename("");
                                  }}
                                >
                                  Cancel
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                                  onClick={() => {
                                    setEditingManualId(manual.id);
                                    setEditingFilename(manual.filename);
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                                  onClick={() => setTagEditingManual(manual)}
                                  disabled={deletingManualId === manual.id || bulkDeleting}
                                >
                                  Tags
                                </button>
                                <button
                                  type="button"
                                  className="admin-panel__btn admin-panel__btn--danger admin-panel__btn--compact"
                                  onClick={() => setConfirmDeleteId(manual.id)}
                                  disabled={deletingManualId === manual.id || bulkDeleting}
                                >
                                  {deletingManualId === manual.id ? "..." : "Delete"}
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="admin-panel__state-box admin-panel__manuals-state">
              <span className="admin-panel__muted">{emptyStateMessage}</span>
            </div>
          )}
        </div>

        <div className="admin-panel__modal-actions">
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--full"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>

      {confirmBulkDelete && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.4)",
            zIndex: 60,
          }}
        >
          <div className="admin-panel__modal" style={{ maxWidth: 520 }}>
            <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
              <XIcon />
            </div>
            <h3 className="admin-panel__modal-title">Delete selected files?</h3>
            <p className="admin-panel__modal-desc">
              This will permanently remove {selectedManualCount} selected file
              {selectedManualCount === 1 ? "" : "s"} from{" "}
              {activeCategoryConfig.folderLabel}. This action cannot be undone.
            </p>
            <div className="admin-panel__modal-actions">
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--ghost"
                onClick={() => setConfirmBulkDelete(false)}
                disabled={bulkDeleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--danger"
                onClick={async () => {
                  setConfirmBulkDelete(false);
                  await handleBulkDelete();
                }}
                disabled={bulkDeleting}
              >
                {bulkDeleting ? "Deleting..." : "Delete selected"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmDeleteId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0,0,0,0.4)",
            zIndex: 60,
          }}
        >
          <div className="admin-panel__modal" style={{ maxWidth: 520 }}>
            <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
              <XIcon />
            </div>
            <h3 className="admin-panel__modal-title">Delete file?</h3>
            <p className="admin-panel__modal-desc">
              This will permanently remove the file from{" "}
              {activeCategoryConfig.folderLabel}. This action cannot be undone.
            </p>
            <div className="admin-panel__modal-actions">
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--ghost"
                onClick={() => setConfirmDeleteId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--danger"
                onClick={async () => {
                  const id = confirmDeleteId;
                  setConfirmDeleteId(null);
                  if (!id) return;
                  await handleDelete(id);
                }}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {tagEditingManual && (
        <TagLinksEditorModal
          token={token}
          title="Edit document tags"
          entityLabel={tagEditingManual.filename}
          selectionMode="multiple"
          onClose={() => setTagEditingManual(null)}
          onError={onError}
          loadSelectedTags={() =>
            getManualTags(shipId, tagEditingManual.id, token ?? "")
          }
          saveSelectedTags={(tagIds) =>
            replaceManualTags(shipId, tagEditingManual.id, tagIds, token ?? "")
          }
        />
      )}
    </div>
  );
}
