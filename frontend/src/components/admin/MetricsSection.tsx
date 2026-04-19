import { useEffect, useState } from "react";
import { useAdminShip } from "../../context/AdminShipContext";
import { useShipMetricsAdminData } from "../../hooks/admin/useShipMetricsAdminData";
import { MetricsIcon, ShipIcon } from "./AdminPanelIcons";

interface MetricsSectionProps {
  token: string | null;
}

interface MetricsTableRow {
  id: string;
  bucket: string;
  key: string;
  field: string;
  description: string | null;
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
  const {
    catalog,
    loading,
    syncing,
    error,
    setError,
    syncCatalog,
    updateDescription,
    lastSyncResult,
  } = useShipMetricsAdminData(
    token,
    selectedShipId,
    Boolean(token && selectedShipId),
  );

  const [editingMetricId, setEditingMetricId] = useState<string | null>(null);
  const [draftDescription, setDraftDescription] = useState("");
  const [savingMetricId, setSavingMetricId] = useState<string | null>(null);
  const [selectedBucketFilter, setSelectedBucketFilter] =
    useState(ALL_BUCKETS_FILTER);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    if (!selectedShipId && availableShips.length > 0) {
      setSelectedShipId(availableShips[0].id);
    }
  }, [availableShips, selectedShipId, setSelectedShipId]);

  useEffect(() => {
    setSelectedBucketFilter(ALL_BUCKETS_FILTER);
    setCurrentPage(1);
    setEditingMetricId(null);
    setDraftDescription("");
    setSavingMetricId(null);
  }, [selectedShipId]);

  useEffect(() => {
    if (
      selectedBucketFilter !== ALL_BUCKETS_FILTER &&
      catalog &&
      !catalog.buckets.some(
        (bucketGroup) => bucketGroup.bucket === selectedBucketFilter,
      )
    ) {
      setSelectedBucketFilter(ALL_BUCKETS_FILTER);
    }
  }, [catalog, selectedBucketFilter]);

  const handleStartEditing = (metricId: string, description: string | null) => {
    setError("");
    setEditingMetricId(metricId);
    setDraftDescription(description ?? "");
  };

  const handleCancelEditing = () => {
    setEditingMetricId(null);
    setDraftDescription("");
  };

  const handleSaveDescription = async (metricId: string) => {
    setSavingMetricId(metricId);
    const updatedMetric = await updateDescription(
      metricId,
      draftDescription.trim() || null,
    );

    if (updatedMetric) {
      setEditingMetricId(null);
      setDraftDescription("");
    }

    setSavingMetricId(null);
  };

  const activeError = error || shipsError || "";
  const bucketOptions = catalog?.buckets ?? [];
  const filteredMetrics: MetricsTableRow[] = [];

  if (catalog) {
    for (const bucketGroup of catalog.buckets) {
      if (
        selectedBucketFilter !== ALL_BUCKETS_FILTER &&
        bucketGroup.bucket !== selectedBucketFilter
      ) {
        continue;
      }

      for (const metric of bucketGroup.metrics) {
        filteredMetrics.push({
          id: metric.id,
          bucket: bucketGroup.bucket,
          key: metric.key,
          field: metric.field,
          description: metric.description,
        });
      }
    }
  }

  const totalFilteredMetrics = filteredMetrics.length;
  const totalPages = Math.max(1, Math.ceil(totalFilteredMetrics / pageSize));

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex =
    totalFilteredMetrics === 0 ? 0 : (safeCurrentPage - 1) * pageSize;
  const paginatedMetrics = filteredMetrics.slice(
    pageStartIndex,
    pageStartIndex + pageSize,
  );
  const visibleFrom = totalFilteredMetrics === 0 ? 0 : pageStartIndex + 1;
  const visibleTo = Math.min(pageStartIndex + pageSize, totalFilteredMetrics);
  const selectedBucketLabel =
    selectedBucketFilter === ALL_BUCKETS_FILTER
      ? "All buckets"
      : selectedBucketFilter;
  const syncStatusText = syncing
    ? "Syncing catalog from Influx..."
    : lastSyncResult
      ? `Last sync updated ${lastSyncResult.metricsSynced} metrics across ${lastSyncResult.bucketCount} buckets.`
      : catalog?.syncedAt
        ? `Catalog loaded. Last sync: ${formatSyncDate(catalog.syncedAt)}.`
        : "Catalog has not been synced yet.";

  return (
    <section className="admin-panel__section">
      <div className="admin-panel__section-head">
        <div className="admin-panel__section-intro">
          <h2 className="admin-panel__section-title">Metrics</h2>
          <p className="admin-panel__section-subtitle">
            Select a ship, filter its metric catalog by bucket, and edit metric
            descriptions from one place.
          </p>
        </div>
        <button
          type="button"
          className="admin-panel__btn admin-panel__btn--primary"
          onClick={() => void syncCatalog()}
          disabled={!selectedShipId || syncing || shipsLoading}
        >
          {syncing ? "Syncing..." : "Sync from Influx"}
        </button>
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
                  value={selectedShipId ?? ""}
                  onChange={(event) =>
                    setSelectedShipId(event.target.value || null)
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
              <div className="admin-panel__field">
                <label className="admin-panel__field-label">Bucket</label>
                <select
                  className="admin-panel__select"
                  value={selectedBucketFilter}
                  onChange={(event) => {
                    setSelectedBucketFilter(event.target.value);
                    setCurrentPage(1);
                  }}
                  disabled={!catalog || bucketOptions.length === 0}
                >
                  <option value={ALL_BUCKETS_FILTER}>All buckets</option>
                  {bucketOptions.map((bucketGroup) => (
                    <option key={bucketGroup.bucket} value={bucketGroup.bucket}>
                      {bucketGroup.bucket} ({bucketGroup.totalMetrics})
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {(loading || syncing) && !catalog ? (
            <div className="admin-panel__state-box">
              <div className="admin-panel__spinner" />
              <span className="admin-panel__muted">Loading metrics...</span>
            </div>
          ) : !selectedShipId ? (
            <div className="admin-panel__state-box">
              <MetricsIcon />
              <span className="admin-panel__muted">
                Select a ship to view its metric catalog.
              </span>
            </div>
          ) : !catalog || catalog.totalMetrics === 0 ? (
            <div className="admin-panel__state-box">
              <MetricsIcon />
              <span className="admin-panel__muted">
                No metrics were discovered for this ship yet.
              </span>
            </div>
          ) : (
            <div className="admin-panel__metrics-group-card">
              <div className="admin-panel__metrics-group-header">
                <div className="admin-panel__metrics-group-meta">
                  <span className="admin-panel__metrics-bucket-badge admin-panel__metrics-bucket-badge--active">
                    {selectedBucketLabel}
                  </span>
                  <span className="admin-panel__muted">
                    Showing {visibleFrom}-{visibleTo} of {totalFilteredMetrics} metrics
                  </span>
                </div>

                <div className="admin-panel__metrics-table-tools">
                  <span className="admin-panel__muted">
                    {syncStatusText}
                  </span>
                  <div className="admin-panel__manuals-pager">
                    <div className="admin-panel__manuals-page-size">
                      <span className="admin-panel__manuals-page-size-label">
                        Rows
                      </span>
                      <select
                        className="admin-panel__select admin-panel__select--compact"
                        value={String(pageSize)}
                        onChange={(event) => {
                          setPageSize(Number(event.target.value));
                          setCurrentPage(1);
                        }}
                      >
                        {METRICS_PAGE_SIZE_OPTIONS.map((option) => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </div>
                    <button
                      type="button"
                      className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                      onClick={() =>
                        setCurrentPage((page) => Math.max(1, page - 1))
                      }
                      disabled={safeCurrentPage <= 1}
                    >
                      Previous
                    </button>
                    <span className="admin-panel__manuals-page-indicator">
                      Page {safeCurrentPage} of {totalPages}
                    </span>
                    <button
                      type="button"
                      className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                      onClick={() =>
                        setCurrentPage((page) => Math.min(totalPages, page + 1))
                      }
                      disabled={safeCurrentPage >= totalPages}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </div>

              <div className="admin-panel__metrics-group-table-wrap">
                <table className="admin-panel__table admin-panel__table--metrics">
                  <colgroup>
                    <col className="admin-panel__metrics-col admin-panel__metrics-col--bucket" />
                    <col className="admin-panel__metrics-col admin-panel__metrics-col--key" />
                    <col className="admin-panel__metrics-col admin-panel__metrics-col--field" />
                    <col className="admin-panel__metrics-col admin-panel__metrics-col--description" />
                    <col className="admin-panel__metrics-col admin-panel__metrics-col--action" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th className="admin-panel__th">Bucket</th>
                      <th className="admin-panel__th">Full key</th>
                      <th className="admin-panel__th">Field</th>
                      <th className="admin-panel__th">Description</th>
                      <th className="admin-panel__th">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedMetrics.length === 0 ? (
                      <tr className="admin-panel__row">
                        <td className="admin-panel__td" colSpan={5}>
                          <span className="admin-panel__muted">
                            No metrics match the current bucket filter.
                          </span>
                        </td>
                      </tr>
                    ) : (
                      paginatedMetrics.map((metric) => {
                        const isEditing = editingMetricId === metric.id;
                        const isSaving = savingMetricId === metric.id;

                        return (
                          <tr key={metric.id} className="admin-panel__row">
                            <td className="admin-panel__td">
                              <span className="admin-panel__metrics-bucket-badge">
                                {metric.bucket}
                              </span>
                            </td>
                            <td className="admin-panel__td admin-panel__td--key">
                              <code className="admin-panel__code-inline admin-panel__code-inline--metric">
                                {metric.key}
                              </code>
                            </td>
                            <td className="admin-panel__td admin-panel__td--field">
                              {metric.field}
                            </td>
                            <td className="admin-panel__td admin-panel__td--desc">
                              {isEditing ? (
                                <textarea
                                  className="admin-panel__input admin-panel__textarea"
                                  rows={3}
                                  value={draftDescription}
                                  onChange={(event) =>
                                    setDraftDescription(event.target.value)
                                  }
                                  disabled={isSaving}
                                />
                              ) : metric.description ? (
                                <div className="admin-panel__metric-description-text">
                                  {metric.description}
                                </div>
                              ) : (
                                <span className="admin-panel__muted">
                                  No description yet
                                </span>
                              )}
                            </td>
                            <td className="admin-panel__td">
                              <div className="admin-panel__actions">
                                {isEditing ? (
                                  <>
                                    <button
                                      type="button"
                                      className="admin-panel__btn admin-panel__btn--primary admin-panel__btn--compact"
                                      onClick={() =>
                                        void handleSaveDescription(metric.id)
                                      }
                                      disabled={isSaving}
                                    >
                                      {isSaving ? "Saving..." : "Save"}
                                    </button>
                                    <button
                                      type="button"
                                      className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                                      onClick={handleCancelEditing}
                                      disabled={isSaving}
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    type="button"
                                    className="admin-panel__btn admin-panel__btn--ghost admin-panel__btn--compact"
                                    onClick={() =>
                                      handleStartEditing(
                                        metric.id,
                                        metric.description,
                                      )
                                    }
                                  >
                                    Edit
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
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
