import { useCallback, useDeferredValue, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { updateMetricBinding } from "../../api/assetsApi";
import { useAdminShip } from "../../context/AdminShipContext";
import { useShipMetricsAdminData } from "../../hooks/admin/useShipMetricsAdminData";
import { useShipMetricsCatalogPageData } from "../../hooks/admin/useShipMetricsCatalogPageData";
import { MetricsIcon, SearchIcon, ShipIcon } from "./AdminPanelIcons";
import { MetricsSemanticConceptsPanel } from "./MetricsSemanticConceptsPanel";
import { BindAssetPicker } from "./metrics/BindAssetPicker";

interface MetricsSectionProps {
  token: string | null;
}

interface MetricsTableRow {
  id: string;
  bucket: string;
  key: string;
  description: string | null;
  isEnabled: boolean;
  boundAssetId: string | null;
  boundAssetIdInternal: string | null;
  boundAssetName: string | null;
  aiBoundConfidence: number | null;
}

interface MetricDescriptionCellProps {
  metric: MetricsTableRow;
  isEditing: boolean;
  draftDescription: string;
  isSaving: boolean;
  error: string | null;
  disabled: boolean;
  onStartEditing: () => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
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

function MetricDescriptionCell({
  metric,
  isEditing,
  draftDescription,
  isSaving,
  error,
  disabled,
  onStartEditing,
  onDraftChange,
  onSave,
  onCancel,
}: MetricDescriptionCellProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSave();
    }
  };

  if (isEditing) {
    return (
      <div className="admin-panel__metric-inline-editor">
        <textarea
          className="admin-panel__metric-inline-textarea"
          value={draftDescription}
          onChange={(event) => onDraftChange(event.target.value)}
          onBlur={onSave}
          onKeyDown={handleKeyDown}
          disabled={isSaving}
          rows={3}
          maxLength={5000}
          placeholder="Describe what this metric represents..."
          autoFocus
        />
        <div className="admin-panel__metric-inline-actions">
          <span className="admin-panel__metric-inline-hint">
            {isSaving ? "Saving..." : "Enter to save, Esc to cancel"}
          </span>
          <div className="admin-panel__metric-inline-buttons">
            <button
              type="button"
              className="admin-panel__metric-inline-icon-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onSave}
              disabled={isSaving}
              aria-label="Save description"
              title="Save"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </button>
            <button
              type="button"
              className="admin-panel__metric-inline-icon-btn"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onCancel}
              disabled={isSaving}
              aria-label="Cancel description edit"
              title="Cancel"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>
        {error && <div className="admin-panel__metric-inline-error">{error}</div>}
      </div>
    );
  }

  // Prefer the Claude profiler's aiDescription over the synced/Grafana one.
  const shownDescription = metric.aiDescription ?? metric.description;
  return (
    <button
      type="button"
      className="admin-panel__metric-description-editable"
      onClick={onStartEditing}
      disabled={disabled}
      title={
        shownDescription
          ? `${shownDescription} Click to edit.`
          : "Click to add description."
      }
    >
      {shownDescription ? (
        <span className="admin-panel__metric-description-text">
          {shownDescription}
        </span>
      ) : (
        <span className="admin-panel__metric-description-placeholder">
          Click to add description
        </span>
      )}
    </button>
  );
}

export function MetricsSection({ token }: MetricsSectionProps) {
  const {
    availableShips,
    selectedShipId,
    isLoading: shipsLoading,
    error: shipsError,
  } = useAdminShip();
  const [editingMetricId, setEditingMetricId] = useState<string | null>(null);
  const editingMetricIdRef = useRef<string | null>(null);
  const [draftDescription, setDraftDescription] = useState("");
  const [savingMetricId, setSavingMetricId] = useState<string | null>(null);
  const [descriptionEditError, setDescriptionEditError] = useState<{
    metricId: string;
    message: string;
  } | null>(null);
  const [selectedBucketFilter, setSelectedBucketFilter] =
    useState(ALL_BUCKETS_FILTER);
  const [boundFilter, setBoundFilter] = useState<"all" | "bound" | "unbound">(
    "all",
  );
  const [catalogSearch, setCatalogSearch] = useState("");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [currentPage, setCurrentPage] = useState(1);
  // Which metric is currently showing the asset-bind picker (one at a time).
  const [bindingMetricId, setBindingMetricId] = useState<string | null>(null);
  const [unbindingMetricId, setUnbindingMetricId] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<"catalog" | "semantics">(
    "catalog",
  );
  const deferredCatalogSearch = useDeferredValue(catalogSearch.trim());
  const isCatalogView = activeView === "catalog";
  const effectiveSelectedShipId = selectedShipId ?? availableShips[0]?.id ?? null;

  const setActiveEditingMetric = useCallback((metricId: string | null) => {
    editingMetricIdRef.current = metricId;
    setEditingMetricId(metricId);
  }, []);

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
    refreshCatalog,
    analyzing: catalogAnalyzing,
    analyzeProgress: catalogAnalyzeProgress,
    analyzeCatalog,
    lastSyncResult: catalogLastSyncResult,
  } = useShipMetricsCatalogPageData(token, effectiveSelectedShipId, {
    search: deferredCatalogSearch,
    bucket:
      selectedBucketFilter === ALL_BUCKETS_FILTER ? null : selectedBucketFilter,
    bound: boundFilter,
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

  const handleStartEditing = (metric: MetricsTableRow) => {
    setCatalogError("");
    setDescriptionEditError(null);
    setActiveEditingMetric(metric.id);
    setDraftDescription(metric.description ?? "");
  };

  const handleCancelEditing = useCallback(() => {
    setActiveEditingMetric(null);
    setDraftDescription("");
    setDescriptionEditError(null);
  }, [setActiveEditingMetric]);

  const handleSaveDescription = async (metric: MetricsTableRow) => {
    if (savingMetricId === metric.id) {
      return;
    }

    const normalizedDescription = draftDescription.trim() || null;
    const currentDescription = metric.description?.trim() || null;

    if (normalizedDescription === currentDescription) {
      handleCancelEditing();
      return;
    }

    if (draftDescription.length > 5000) {
      setDescriptionEditError({
        metricId: metric.id,
        message: "Description is too long.",
      });
      return;
    }

    setDescriptionEditError(null);
    setSavingMetricId(metric.id);
    const updatedMetric = await updateDescription(
      metric.id,
      normalizedDescription,
    );

    if (updatedMetric) {
      if (editingMetricIdRef.current === metric.id) {
        setActiveEditingMetric(null);
        setDraftDescription("");
      }
    } else if (editingMetricIdRef.current === metric.id) {
      setDescriptionEditError({
        metricId: metric.id,
        message: "Could not save description.",
      });
    }

    setSavingMetricId(null);
  };

  const handleUnbindMetric = useCallback(
    async (metricId: string) => {
      if (!token) return;
      setUnbindingMetricId(metricId);
      try {
        await updateMetricBinding(token, metricId, null);
        await refreshCatalog();
      } catch (e) {
        setCatalogError(e instanceof Error ? e.message : "Unbind failed");
      } finally {
        setUnbindingMetricId(null);
      }
    },
    [token, refreshCatalog, setCatalogError],
  );

  const activeError = (isCatalogView ? catalogError : semanticError) || shipsError || "";
  const paginatedMetrics: MetricsTableRow[] =
    catalogPage?.items.map((metric) => ({
      id: metric.id,
      bucket: metric.bucket,
      key: metric.key,
      description: metric.description,
      isEnabled: metric.isEnabled,
      boundAssetId: metric.boundAssetId,
      boundAssetIdInternal: metric.boundAsset?.assetIdInternal ?? null,
      boundAssetName: metric.boundAsset?.displayName ?? null,
      aiBoundConfidence: metric.aiBoundConfidence,
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

          {isCatalogView && (
            <button
              type="button"
              className="admin-panel__sync-btn"
              onClick={() => void analyzeCatalog()}
              disabled={
                !effectiveSelectedShipId ||
                catalogAnalyzing ||
                catalogSyncing ||
                shipsLoading
              }
              title="Run AI analysis (kind / unit / bound asset + 7-day fingerprint) for this ship's metrics. Required before the metric chat can answer."
            >
              <svg
                className={`admin-panel__sync-icon ${
                  catalogAnalyzing ? "admin-panel__sync-icon--spin" : ""
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
                <path d="M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
              </svg>
              {catalogAnalyzing
                ? catalogAnalyzeProgress
                  ? `Analyzing ${catalogAnalyzeProgress.done}/${catalogAnalyzeProgress.total}…`
                  : "Analyzing…"
                : "Analyze (AI)"}
            </button>
          )}
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
                    <label className="admin-panel__field-label">Binding</label>
                    <div className="metrics-bound-filter">
                      {(["all", "bound", "unbound"] as const).map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          className={`metrics-bound-filter__pill ${
                            boundFilter === opt
                              ? "metrics-bound-filter__pill--active"
                              : ""
                          }`}
                          onClick={() => {
                            setBoundFilter(opt);
                            setCurrentPage(1);
                          }}
                        >
                          {opt === "all"
                            ? "All"
                            : opt === "bound"
                              ? "Bound to asset"
                              : "Unbound"}
                        </button>
                      ))}
                    </div>
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
                <table className="admin-panel__table admin-panel__table--metrics admin-panel__table--metrics-catalog">
                  <colgroup>
                    <col className="admin-panel__metrics-catalog-col admin-panel__metrics-catalog-col--toggle" />
                    <col className="admin-panel__metrics-catalog-col admin-panel__metrics-catalog-col--bucket" />
                    <col className="admin-panel__metrics-catalog-col admin-panel__metrics-catalog-col--key" />
                    <col className="admin-panel__metrics-catalog-col admin-panel__metrics-catalog-col--description" />
                    <col className="admin-panel__metrics-catalog-col admin-panel__metrics-catalog-col--asset" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="admin-panel__th admin-panel__th--toggle" />
                      <th className="admin-panel__th">Bucket</th>
                      <th className="admin-panel__th">Key</th>
                      <th className="admin-panel__th">Description</th>
                      <th className="admin-panel__th">Bound asset</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedMetrics.length === 0 ? (
                      <tr className="admin-panel__row admin-panel__row--metrics-empty">
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
                          <td className="admin-panel__td admin-panel__td--metric-bucket">
                            <span
                              className="admin-panel__metrics-bucket-badge"
                              title={metric.bucket}
                            >
                              {metric.bucket}
                            </span>
                          </td>
                          <td className="admin-panel__td admin-panel__td--key" title={metric.key}>
                            <code className="admin-panel__code-inline admin-panel__code-inline--metric">
                              {formatKeyShort(metric.key)}
                            </code>
                          </td>
                          <td className="admin-panel__td admin-panel__td--desc">
                            <MetricDescriptionCell
                              metric={metric}
                              isEditing={editingMetricId === metric.id}
                              draftDescription={draftDescription}
                              isSaving={savingMetricId === metric.id}
                              error={
                                descriptionEditError?.metricId === metric.id
                                  ? descriptionEditError.message
                                  : null
                              }
                              disabled={catalogSyncing || catalogToggling}
                              onStartEditing={() => handleStartEditing(metric)}
                              onDraftChange={setDraftDescription}
                              onSave={() => void handleSaveDescription(metric)}
                              onCancel={handleCancelEditing}
                            />
                          </td>
                          <td className="admin-panel__td admin-panel__td--asset">
                            {metric.boundAssetId ? (
                              <div
                                className="metrics-bound-asset"
                                title={metric.boundAssetName ?? undefined}
                              >
                                <span className="metrics-bound-asset__code">
                                  {metric.boundAssetIdInternal}
                                </span>
                                <span className="metrics-bound-asset__name">
                                  {metric.boundAssetName}
                                </span>
                                {typeof metric.aiBoundConfidence ===
                                  "number" && (
                                  <span
                                    className={`metrics-bound-asset__conf metrics-bound-asset__conf--${
                                      metric.aiBoundConfidence >= 1
                                        ? "verified"
                                        : metric.aiBoundConfidence >= 0.8
                                          ? "high"
                                          : metric.aiBoundConfidence >= 0.6
                                            ? "medium"
                                            : "low"
                                    }`}
                                    title={
                                      metric.aiBoundConfidence >= 1
                                        ? "Human-verified binding"
                                        : `AI confidence ${Math.round(metric.aiBoundConfidence * 100)}%`
                                    }
                                  >
                                    {metric.aiBoundConfidence >= 1
                                      ? "✓"
                                      : `${Math.round(metric.aiBoundConfidence * 100)}%`}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  className="metrics-bound-asset__action"
                                  onClick={() =>
                                    setBindingMetricId((cur) =>
                                      cur === metric.id ? null : metric.id,
                                    )
                                  }
                                  title="Change asset binding"
                                  aria-label="Change asset"
                                >
                                  ✎
                                </button>
                                <button
                                  type="button"
                                  className="metrics-bound-asset__action"
                                  onClick={() => void handleUnbindMetric(metric.id)}
                                  disabled={unbindingMetricId === metric.id}
                                  title="Unbind from this asset"
                                  aria-label="Unbind"
                                >
                                  {unbindingMetricId === metric.id ? "…" : "×"}
                                </button>
                              </div>
                            ) : (
                              <div className="metrics-bound-asset">
                                <span className="metrics-bound-asset__unbound">
                                  unbound
                                </span>
                                <button
                                  type="button"
                                  className="metrics-bound-asset__action metrics-bound-asset__action--cta"
                                  onClick={() =>
                                    setBindingMetricId((cur) =>
                                      cur === metric.id ? null : metric.id,
                                    )
                                  }
                                  title="Bind this metric to an asset"
                                >
                                  + bind
                                </button>
                              </div>
                            )}
                            {bindingMetricId === metric.id &&
                              effectiveSelectedShipId && (
                                <BindAssetPicker
                                  token={token}
                                  shipId={effectiveSelectedShipId}
                                  metricId={metric.id}
                                  currentAssetIdInternal={
                                    metric.boundAssetIdInternal
                                  }
                                  onClose={() => setBindingMetricId(null)}
                                  onBound={() => {
                                    void refreshCatalog();
                                    setBindingMetricId(null);
                                  }}
                                />
                              )}
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
    </section>
  );
}
