import { useCallback, useDeferredValue, useRef, useState } from "react";
import { useAdminShip } from "../../context/AdminShipContext";
import { useShipMetricsAdminData } from "../../hooks/admin/useShipMetricsAdminData";
import { useShipMetricsCatalogPageData } from "../../hooks/admin/useShipMetricsCatalogPageData";
import { MetricsIcon, SearchIcon, ShipIcon } from "./AdminPanelIcons";
import { MetricsSemanticConceptsPanel } from "./MetricsSemanticConceptsPanel";

interface MetricsSectionProps {
  token: string | null;
}

interface MetricsTableRow {
  id: string;
  bucket: string;
  key: string;
  description: string | null;
  isEnabled: boolean;
}

const syncDateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const ALL_BUCKETS_FILTER = "all";
const METRICS_PAGE_SIZE_OPTIONS = [25, 50, 100];
const DEFAULT_PAGE_SIZE = METRICS_PAGE_SIZE_OPTIONS[0];

/** Strip the first segment (bucket prefix) before the first `::`. */
function formatKeyShort(fullKey: string): string {
  const idx = fullKey.indexOf("::");
  if (idx < 0) return fullKey;
  return fullKey.slice(idx + 2);
}

function formatSyncDate(value: string | null): string {
  if (!value) {
    return "-";
  }

  const parsedDate = new Date(value);
  return Number.isNaN(parsedDate.getTime())
    ? "-"
    : syncDateFormatter.format(parsedDate);
}

export function MetricsSection({ token }: MetricsSectionProps) {
  const {
    availableShips,
    selectedShipId,
    setSelectedShipId,
    isLoading: shipsLoading,
    error: shipsError,
  } = useAdminShip();
  const [editingMetricId, setEditingMetricId] = useState<string | null>(null);
  const [editingMetricKey, setEditingMetricKey] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [savingMetricId, setSavingMetricId] = useState<string | null>(null);
  const [showEditModal, setShowEditModal] = useState(false);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [selectedBucketFilter, setSelectedBucketFilter] =
    useState(ALL_BUCKETS_FILTER);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [currentPage, setCurrentPage] = useState(1);
  const [activeView, setActiveView] = useState<"catalog" | "semantics">(
    "catalog",
  );
  const deferredCatalogSearch = useDeferredValue(catalogSearch.trim());
  const isCatalogView = activeView === "catalog";
  const effectiveSelectedShipId = selectedShipId ?? availableShips[0]?.id ?? null;

  const {
    catalogPage,
    loading: catalogLoading,
    syncing: catalogSyncing,
    toggling: catalogToggling,
    error: catalogError,
    setError: setCatalogError,
    syncCatalog: syncCatalogPage,
    updateDescription,
    toggleMetrics,
    lastSyncResult: catalogLastSyncResult,
  } = useShipMetricsCatalogPageData(token, effectiveSelectedShipId, {
    search: deferredCatalogSearch,
    bucket:
      selectedBucketFilter === ALL_BUCKETS_FILTER ? null : selectedBucketFilter,
    page: currentPage,
    pageSize,
    enabled: Boolean(token && effectiveSelectedShipId && isCatalogView),
  });

  const {
    catalog,
    syncing: semanticSyncing,
    error: semanticError,
    syncCatalog: syncSemanticCatalog,
    lastSyncResult: semanticLastSyncResult,
  } = useShipMetricsAdminData(
    token,
    effectiveSelectedShipId,
    Boolean(token && effectiveSelectedShipId && !isCatalogView),
  );
  const bucketOptions = catalogPage?.buckets ?? [];
  const effectiveSelectedBucketFilter =
    selectedBucketFilter === ALL_BUCKETS_FILTER ||
    bucketOptions.some(
      (bucketOption) => bucketOption.bucket === selectedBucketFilter,
    )
      ? selectedBucketFilter
      : ALL_BUCKETS_FILTER;

  const resetCatalogViewState = useCallback(() => {
    setSelectedBucketFilter(ALL_BUCKETS_FILTER);
    setCatalogSearch("");
    setCurrentPage(1);
    setEditingMetricId(null);
    setEditingMetricKey("");
    setDraftDescription("");
    setSavingMetricId(null);
    setShowEditModal(false);
    setActiveView("catalog");
  }, []);

  const handleShipSelectionChange = useCallback(
    (nextShipId: string | null) => {
      resetCatalogViewState();
      setSelectedShipId(nextShipId);
    },
    [resetCatalogViewState, setSelectedShipId],
  );

  const handleStartEditing = (metricId: string, metricKey: string, description: string | null) => {
    setCatalogError("");
    setEditingMetricId(metricId);
    setEditingMetricKey(metricKey);
    setDraftDescription(description ?? "");
    setShowEditModal(true);
    requestAnimationFrame(() => editTextareaRef.current?.focus());
  };

  const handleCancelEditing = useCallback(() => {
    setShowEditModal(false);
    setEditingMetricId(null);
    setEditingMetricKey("");
    setDraftDescription("");
  }, []);

  const handleSaveDescription = async (metricId: string) => {
    setSavingMetricId(metricId);
    const updatedMetric = await updateDescription(
      metricId,
      draftDescription.trim() || null,
    );

    if (updatedMetric) {
      setShowEditModal(false);
      setEditingMetricId(null);
      setEditingMetricKey("");
      setDraftDescription("");
    }

    setSavingMetricId(null);
  };

  const activeError = (isCatalogView ? catalogError : semanticError) || shipsError || "";
  const paginatedMetrics: MetricsTableRow[] =
    catalogPage?.items.map((metric) => ({
      id: metric.id,
      bucket: metric.bucket,
      key: metric.key,
      description: metric.description,
      isEnabled: metric.isEnabled,
    })) ?? [];
  const totalFilteredMetrics = catalogPage?.filteredMetrics ?? 0;
  const totalPages = catalogPage?.totalPages ?? 1;
  const safeCurrentPage = catalogPage?.page ?? currentPage;
  const activePageSize = catalogPage?.pageSize ?? pageSize;
  const pageStartIndex =
    totalFilteredMetrics === 0 ? 0 : (safeCurrentPage - 1) * activePageSize;
  const visibleFrom = totalFilteredMetrics === 0 ? 0 : pageStartIndex + 1;
  const visibleTo =
    totalFilteredMetrics === 0
      ? 0
      : Math.min(pageStartIndex + paginatedMetrics.length, totalFilteredMetrics);
  const selectedBucketLabel =
    effectiveSelectedBucketFilter === ALL_BUCKETS_FILTER
      ? "All buckets"
      : effectiveSelectedBucketFilter;
  const syncStatusText = catalogSyncing
    ? "Syncing catalog from Influx..."
    : catalogLastSyncResult
      ? `Last sync updated ${catalogLastSyncResult.metricsSynced} metrics across ${catalogLastSyncResult.bucketCount} buckets.`
      : catalogPage?.syncedAt
        ? `Catalog loaded. Last sync: ${formatSyncDate(catalogPage.syncedAt)}.`
        : "Catalog has not been synced yet.";

  return (
    <section className="admin-panel__section">
      <div className="admin-panel__section-head">
        <div className="admin-panel__section-intro">
          <h2 className="admin-panel__section-title">Metrics</h2>
          <p className="admin-panel__section-subtitle">
            Manage both the raw Influx metric catalog and the semantic concepts
            that power chat resolution.
          </p>
        </div>
        <div className="admin-panel__metrics-head-controls">
          <div className="admin-panel__seg" role="tablist" aria-label="Metrics view">
            <div
              className={`admin-panel__seg-indicator ${
                activeView === "semantics" ? "admin-panel__seg-indicator--right" : ""
              }`}
              aria-hidden="true"
            />
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "catalog"}
              className={`admin-panel__seg-btn ${
                activeView === "catalog" ? "admin-panel__seg-btn--active" : ""
              }`}
              onClick={() => setActiveView("catalog")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />
              </svg>
              Raw catalog
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "semantics"}
              className={`admin-panel__seg-btn ${
                activeView === "semantics" ? "admin-panel__seg-btn--active" : ""
              }`}
              onClick={() => setActiveView("semantics")}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                <path d="M2 12h20" />
              </svg>
              Semantic layer
            </button>
          </div>

          <button
            type="button"
            className="admin-panel__sync-btn"
            onClick={() =>
              void (isCatalogView ? syncCatalogPage() : syncSemanticCatalog())
            }
            disabled={
              !effectiveSelectedShipId ||
              (isCatalogView ? catalogSyncing : semanticSyncing) ||
              shipsLoading
            }
          >
            <svg
              className={`admin-panel__sync-icon ${
                (isCatalogView ? catalogSyncing : semanticSyncing)
                  ? "admin-panel__sync-icon--spin"
                  : ""
              }`}
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21.5 2v6h-6M2.5 22v-6h6" />
              <path d="M2.5 11.5a10 10 0 0 1 18.4-4.3M21.5 12.5a10 10 0 0 1-18.4 4.3" />
            </svg>
            {isCatalogView ? (catalogSyncing ? "Syncing…" : "Sync from Influx") : semanticSyncing ? "Syncing…" : "Sync from Influx"}
          </button>
        </div>
      </div>

      {activeError && (
        <div className="admin-panel__error" role="alert">
          {activeError}
        </div>
      )}

      {shipsLoading && !availableShips.length ? (
        <div className="admin-panel__state-box">
          <div className="admin-panel__spinner" />
          <span className="admin-panel__muted">Loading ships...</span>
        </div>
      ) : availableShips.length === 0 ? (
        <div className="admin-panel__state-box">
          <ShipIcon />
          <span className="admin-panel__muted">
            Create at least one ship to sync its metrics.
          </span>
        </div>
      ) : (
        <>
          <div className="admin-panel__form-card admin-panel__metrics-filter-card">
            <div className="admin-panel__form-row">
              <div className="admin-panel__field">
                <label className="admin-panel__field-label">Ship</label>
                <select
                  className="admin-panel__select"
                  value={effectiveSelectedShipId ?? ""}
                  onChange={(event) =>
                    handleShipSelectionChange(event.target.value || null)
                  }
                >
                  <option value="">Select a ship</option>
                  {availableShips.map((ship) => (
                    <option key={ship.id} value={ship.id}>
                      {ship.name}
                      {ship.organizationName
                        ? ` — ${ship.organizationName}`
                        : ""}
                    </option>
                  ))}
                </select>
              </div>
              {isCatalogView && (
                <>
                  <div className="admin-panel__field">
                    <label className="admin-panel__field-label">Bucket</label>
                    <select
                      className="admin-panel__select"
                      value={effectiveSelectedBucketFilter}
                      onChange={(event) => {
                        setSelectedBucketFilter(event.target.value);
                        setCurrentPage(1);
                      }}
                      disabled={
                        !effectiveSelectedShipId || bucketOptions.length === 0
                      }
                    >
                      <option value={ALL_BUCKETS_FILTER}>All buckets</option>
                      {bucketOptions.map((bucketOption) => (
                        <option key={bucketOption.bucket} value={bucketOption.bucket}>
                          {bucketOption.bucket} ({bucketOption.totalMetrics})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="admin-panel__field">
                    <label className="admin-panel__field-label">Search</label>
                    <div className="admin-panel__metrics-search admin-panel__metrics-search--inline">
                      <SearchIcon />
                      <input
                        className="admin-panel__metrics-search-input"
                        type="search"
                        value={catalogSearch}
                        onChange={(event) => {
                          setCatalogSearch(event.target.value);
                          setCurrentPage(1);
                        }}
                        placeholder="Search by key, bucket, field, or description"
                      />
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {activeView === "semantics" ? (
            <MetricsSemanticConceptsPanel
              token={token}
              shipId={effectiveSelectedShipId}
              catalog={catalog}
              syncMarker={
                semanticLastSyncResult?.syncedAt ?? catalog?.syncedAt ?? null
              }
            />
          ) : (catalogLoading || catalogSyncing) && !catalogPage ? (
            <div className="admin-panel__state-box">
              <div className="admin-panel__spinner" />
              <span className="admin-panel__muted">Loading metrics...</span>
            </div>
          ) : !effectiveSelectedShipId ? (
            <div className="admin-panel__state-box">
              <MetricsIcon />
              <span className="admin-panel__muted">
                Select a ship to view its metric catalog.
              </span>
            </div>
          ) : !catalogPage || catalogPage.totalMetrics === 0 ? (
            <div className="admin-panel__state-box">
              <MetricsIcon />
              <span className="admin-panel__muted">
                No metrics were discovered for this ship yet.
              </span>
            </div>
          ) : (
            <div className="admin-panel__metrics-group-card">
              <div className="admin-panel__metrics-toolbar-strip">
                <div className="admin-panel__metrics-toolbar-left">
                  <span className="admin-panel__metrics-bucket-badge admin-panel__metrics-bucket-badge--active">
                    {selectedBucketLabel}
                  </span>
                  <span className="admin-panel__metrics-count">
                    {visibleFrom}–{visibleTo} of {totalFilteredMetrics}
                  </span>
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                    onClick={() => void toggleMetrics(true)}
                    disabled={catalogToggling || catalogSyncing || !effectiveSelectedShipId}
                  >
                    Enable all
                  </button>
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                    onClick={() => void toggleMetrics(false)}
                    disabled={catalogToggling || catalogSyncing || !effectiveSelectedShipId}
                  >
                    Disable all
                  </button>
                </div>

                <div className="admin-panel__metrics-pager">
                  <div className="admin-panel__metrics-pager-size">
                    <span className="admin-panel__metrics-pager-label">Rows</span>
                    <select
                      className="admin-panel__select admin-panel__select--compact"
                      value={String(pageSize)}
                      onChange={(event) => {
                        setPageSize(Number(event.target.value));
                        setCurrentPage(1);
                      }}
                      disabled={catalogLoading || catalogSyncing}
                    >
                      {METRICS_PAGE_SIZE_OPTIONS.map((option) => (
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
                      onClick={() => setCurrentPage(Math.max(1, safeCurrentPage - 1))}
                      disabled={catalogLoading || catalogSyncing || safeCurrentPage <= 1}
                      aria-label="Previous page"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
                    </button>
                    <span className="admin-panel__metrics-pager-indicator">
                      {safeCurrentPage} / {totalPages}
                    </span>
                    <button
                      type="button"
                      className="admin-panel__metrics-pager-btn"
                      onClick={() =>
                        setCurrentPage(Math.min(totalPages, safeCurrentPage + 1))
                      }
                      disabled={
                        catalogLoading ||
                        catalogSyncing ||
                        safeCurrentPage >= totalPages
                      }
                      aria-label="Next page"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
                    </button>
                  </div>
                </div>
              </div>

              {syncStatusText && (
                <div className="admin-panel__metrics-sync-status">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
                  <span>{syncStatusText}</span>
                </div>
              )}

              <div className="admin-panel__metrics-group-table-wrap">
                <table className="admin-panel__table admin-panel__table--metrics">
                  <colgroup>
                    <col style={{ width: '40px' }} />
                    <col style={{ width: '88px' }} />
                    <col style={{ width: '42%' }} />
                    <col />
                    <col style={{ width: '72px' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="admin-panel__th admin-panel__th--toggle" />
                      <th className="admin-panel__th">Bucket</th>
                      <th className="admin-panel__th">Key</th>
                      <th className="admin-panel__th">Description</th>
                      <th className="admin-panel__th" />
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedMetrics.length === 0 ? (
                      <tr className="admin-panel__row">
                        <td className="admin-panel__td" colSpan={5}>
                          <span className="admin-panel__muted">
                            No metrics match the current filters.
                          </span>
                        </td>
                      </tr>
                    ) : (
                      paginatedMetrics.map((metric) => (
                        <tr key={metric.id} className={`admin-panel__row${!metric.isEnabled ? " admin-panel__row--disabled" : ""}`}>
                          <td className="admin-panel__td admin-panel__td--toggle">
                            <input
                              type="checkbox"
                              className="admin-panel__metrics-toggle"
                              checked={metric.isEnabled}
                              disabled={catalogToggling}
                              onChange={() =>
                                void toggleMetrics(!metric.isEnabled, [metric.id])
                              }
                              aria-label={`${metric.isEnabled ? "Disable" : "Enable"} metric ${metric.key}`}
                            />
                          </td>
                          <td className="admin-panel__td">
                            <span className="admin-panel__metrics-bucket-badge">
                              {metric.bucket}
                            </span>
                          </td>
                          <td className="admin-panel__td admin-panel__td--key" title={metric.key}>
                            <code className="admin-panel__code-inline admin-panel__code-inline--metric">
                              {formatKeyShort(metric.key)}
                            </code>
                          </td>
                          <td className="admin-panel__td admin-panel__td--desc">
                            {metric.description ? (
                              <div className="admin-panel__metric-description-text" title={metric.description}>
                                {metric.description}
                              </div>
                            ) : (
                              <span className="admin-panel__muted">
                                —
                              </span>
                            )}
                          </td>
                          <td className="admin-panel__td">
                            <button
                              type="button"
                              className="admin-panel__metrics-edit-btn"
                              onClick={() =>
                                handleStartEditing(
                                  metric.id,
                                  metric.key,
                                  metric.description,
                                )
                              }
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" /></svg>
                              Edit
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Edit description modal ── */}
      {showEditModal && editingMetricId && (
        <div className="admin-panel__modal-overlay" onClick={handleCancelEditing}>
          <div
            className="admin-panel__metrics-edit-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-label="Edit metric description"
          >
            <div className="admin-panel__metrics-edit-modal-head">
              <div className="admin-panel__metrics-edit-modal-title">
                <strong>Edit description</strong>
                <code className="admin-panel__code-inline admin-panel__code-inline--metric">
                  {editingMetricKey}
                </code>
              </div>
              <button
                type="button"
                className="admin-panel__metrics-edit-modal-close"
                onClick={handleCancelEditing}
                aria-label="Close"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
              </button>
            </div>

            <textarea
              ref={editTextareaRef}
              className="admin-panel__input admin-panel__textarea"
              rows={5}
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
              disabled={savingMetricId === editingMetricId}
              placeholder="Describe what this metric represents…"
            />

            <div className="admin-panel__metrics-edit-modal-actions">
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--ghost"
                onClick={handleCancelEditing}
                disabled={savingMetricId === editingMetricId}
              >
                Cancel
              </button>
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--primary"
                onClick={() => void handleSaveDescription(editingMetricId)}
                disabled={savingMetricId === editingMetricId}
              >
                {savingMetricId === editingMetricId ? "Saving…" : "Save description"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
