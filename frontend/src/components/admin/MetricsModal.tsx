import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  MetricDefinitionItem,
  ShipMetricsConfigItem,
} from "../../api/client";
import { updateMetric } from "../../api/client";
import {
  ChevronDownIcon,
  MetricsIcon,
  SearchIcon,
  XIcon,
} from "./AdminPanelIcons";

const ROW_BATCH_SIZE = 120;

function parseMetricKey(key: string) {
  const parts = key.split("::");
  if (parts.length === 3) {
    return { bucket: parts[0], measurement: parts[1], field: parts[2] };
  }
  return { bucket: "-", measurement: key, field: "-" };
}

interface MetricsModalProps {
  token: string | null;
  shipName: string;
  metricsConfig: ShipMetricsConfigItem[];
  metricDefinitions: MetricDefinitionItem[];
  onClose: () => void;
  onError: (msg: string) => void;
  onDefinitionsChanged?: () => void;
}

export function MetricsModal({
  token,
  shipName,
  metricsConfig,
  metricDefinitions,
  onClose,
  onError,
  onDefinitionsChanged,
}: MetricsModalProps) {
  const [search, setSearch] = useState("");
  const [activityFilter, setActivityFilter] = useState<
    "all" | "active" | "inactive"
  >("all");
  const [selectedBuckets, setSelectedBuckets] = useState<string[]>([]);
  const [bucketPickerOpen, setBucketPickerOpen] = useState(false);
  const [bucketSearch, setBucketSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(ROW_BATCH_SIZE);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [saving, setSaving] = useState(false);
  const bucketPickerRef = useRef<HTMLDivElement | null>(null);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  const deferredBucketSearch = useDeferredValue(bucketSearch.trim().toLowerCase());

  useEffect(() => {
    setVisibleCount(ROW_BATCH_SIZE);
  }, [activityFilter, deferredSearch, metricsConfig.length, selectedBuckets]);

  const definitionMap = useMemo(
    () => new Map(metricDefinitions.map((definition) => [definition.key, definition])),
    [metricDefinitions],
  );

  const rows = useMemo(
    () =>
      metricsConfig
        .map((config) => {
          const definition = definitionMap.get(config.metricKey);
          const parsed = parseMetricKey(config.metricKey);
          return {
            key: config.metricKey,
            isActive: config.isActive,
            bucket: definition?.bucket ?? parsed.bucket,
            measurement: definition?.measurement ?? parsed.measurement,
            field: definition?.field ?? parsed.field,
            description: definition?.description ?? null,
            unit: definition?.unit ?? null,
          };
        })
        .sort(
          (left, right) =>
            left.bucket.localeCompare(right.bucket) ||
            left.measurement.localeCompare(right.measurement) ||
            left.field.localeCompare(right.field),
        ),
    [definitionMap, metricsConfig],
  );

  const preBucketRows = useMemo(() => {
    return rows.filter((row) => {
      if (activityFilter === "active" && !row.isActive) {
        return false;
      }

      if (activityFilter === "inactive" && row.isActive) {
        return false;
      }

      if (!deferredSearch) {
        return true;
      }

      return (
        row.bucket.toLowerCase().includes(deferredSearch) ||
        row.measurement.toLowerCase().includes(deferredSearch) ||
        row.field.toLowerCase().includes(deferredSearch) ||
        (row.description?.toLowerCase().includes(deferredSearch) ?? false)
      );
    });
  }, [activityFilter, deferredSearch, rows]);

  const allBucketOptions = useMemo(() => {
    const counts = new Map<string, number>();

    for (const row of rows) {
      counts.set(row.bucket, (counts.get(row.bucket) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, count]) => ({ bucket, count }));
  }, [rows]);

  const filteredBucketCounts = useMemo(() => {
    const counts = new Map<string, number>();

    for (const row of preBucketRows) {
      counts.set(row.bucket, (counts.get(row.bucket) ?? 0) + 1);
    }

    return counts;
  }, [preBucketRows]);

  useEffect(() => {
    const validBuckets = new Set(allBucketOptions.map((option) => option.bucket));

    setSelectedBuckets((previous) => {
      const next = previous.filter((bucket) => validBuckets.has(bucket));
      return next.length === previous.length ? previous : next;
    });
  }, [allBucketOptions]);

  useEffect(() => {
    if (!bucketPickerOpen) {
      setBucketSearch("");
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (
        bucketPickerRef.current &&
        !bucketPickerRef.current.contains(event.target as Node)
      ) {
        setBucketPickerOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [bucketPickerOpen]);

  const bucketPickerOptions = useMemo(() => {
    const options = allBucketOptions.map((option) => ({
      bucket: option.bucket,
      totalCount: option.count,
      filteredCount: filteredBucketCounts.get(option.bucket) ?? 0,
    }));

    if (!deferredBucketSearch) {
      return options;
    }

    return options.filter((option) =>
      option.bucket.toLowerCase().includes(deferredBucketSearch),
    );
  }, [allBucketOptions, deferredBucketSearch, filteredBucketCounts]);

  const filteredRows = useMemo(() => {
    if (selectedBuckets.length === 0) {
      return preBucketRows;
    }

    const selectedSet = new Set(selectedBuckets);
    return preBucketRows.filter((row) => selectedSet.has(row.bucket));
  }, [preBucketRows, selectedBuckets]);

  const visibleRows = useMemo(
    () => filteredRows.slice(0, visibleCount),
    [filteredRows, visibleCount],
  );

  const visibleGroups = useMemo(() => {
    const groups = new Map<string, typeof visibleRows>();
    for (const row of visibleRows) {
      const current = groups.get(row.bucket) ?? [];
      current.push(row);
      groups.set(row.bucket, current);
    }
    return [...groups.entries()];
  }, [visibleRows]);

  const totalCount = rows.length;
  const activeCount = rows.filter((row) => row.isActive).length;
  const describedCount = rows.filter((row) => row.description?.trim()).length;
  const pendingCount = Math.max(totalCount - describedCount, 0);
  const visibleBucketLabel =
    selectedBuckets.length === 0
      ? "All buckets"
      : selectedBuckets.length === 1
        ? `Bucket: ${selectedBuckets[0]}`
        : `${selectedBuckets.length} buckets selected`;
  const visibleBucketMetaLabel =
    selectedBuckets.length === 0
      ? "all buckets"
      : selectedBuckets.length === 1
        ? selectedBuckets[0]
        : `${selectedBuckets.length} selected buckets`;
  const bucketPickerLabel =
    selectedBuckets.length === 0
      ? "All buckets"
      : selectedBuckets.length === 1
        ? selectedBuckets[0]
        : `${selectedBuckets.length} buckets selected`;
  const focusedBucket =
    selectedBuckets.length === 1 ? selectedBuckets[0] : null;
  const hasMultipleBuckets = allBucketOptions.length > 1;
  const hasAnyMetrics = rows.length > 0;
  const hasActiveFilters =
    deferredSearch.length > 0 ||
    activityFilter !== "all" ||
    selectedBuckets.length > 0;

  const handleDescSave = async () => {
    if (!token || !editingKey) return;

    setSaving(true);
    try {
      await updateMetric(editingKey, { description: editDesc }, token);
      onDefinitionsChanged?.();
      setEditingKey(null);
      setEditDesc("");
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Failed to save description",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ap-metrics-modal-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="admin-panel__modal admin-panel__modal--wide admin-panel__modal--scrollable admin-panel__metrics-modal">
        <button
          type="button"
          className="admin-panel__modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          <XIcon />
        </button>

        <div className="admin-panel__modal-head">
          <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
            <MetricsIcon />
          </div>
          <h2 id="ap-metrics-modal-title" className="admin-panel__modal-title">
            Metrics for "{shipName}"
          </h2>
          <p className="admin-panel__modal-desc">
            Review synced metrics, inspect missing descriptions, and update any
            description manually.
          </p>
        </div>

        <div className="admin-panel__metrics-toolbar">
          <div className="admin-panel__metrics-toolbar-main">
            <div className="admin-panel__metrics-search">
              <SearchIcon />
              <input
                type="text"
                className="admin-panel__metrics-search-input"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search bucket, measurement, field, or description..."
              />
            </div>

            <div className="admin-panel__metrics-toolbar-controls">
              {hasMultipleBuckets && (
                <div
                  className="admin-panel__picker admin-panel__metrics-bucket-picker"
                  ref={bucketPickerRef}
                >
                  <button
                    type="button"
                    className="admin-panel__picker-trigger"
                    onClick={() => setBucketPickerOpen((current) => !current)}
                  >
                    {selectedBuckets.length === 0 ? (
                      <span className="admin-panel__picker-placeholder">
                        {bucketPickerLabel}
                      </span>
                    ) : (
                      <span className="admin-panel__picker-summary">
                        {bucketPickerLabel}
                      </span>
                    )}
                    <ChevronDownIcon open={bucketPickerOpen} />
                  </button>

                  {bucketPickerOpen && (
                    <div className="admin-panel__picker-panel">
                      <div className="admin-panel__picker-search-wrap">
                        <SearchIcon />
                        <input
                          type="text"
                          className="admin-panel__picker-search"
                          value={bucketSearch}
                          onChange={(event) => setBucketSearch(event.target.value)}
                          placeholder="Filter buckets..."
                          autoFocus
                        />
                      </div>

                      <div className="admin-panel__picker-actions">
                        <button
                          type="button"
                          className="admin-panel__picker-action-btn"
                          onClick={() =>
                            setSelectedBuckets(
                              allBucketOptions.map((option) => option.bucket),
                            )
                          }
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          className="admin-panel__picker-action-btn"
                          onClick={() => setSelectedBuckets([])}
                        >
                          Clear
                        </button>
                      </div>

                      <div className="admin-panel__picker-list">
                        {bucketPickerOptions.length === 0 ? (
                          <div className="admin-panel__picker-empty">
                            No buckets found
                          </div>
                        ) : (
                          bucketPickerOptions.map((option) => (
                            <label
                              key={option.bucket}
                              className="admin-panel__picker-option"
                            >
                              <input
                                type="checkbox"
                                className="admin-panel__picker-check"
                                checked={selectedBuckets.includes(option.bucket)}
                                onChange={() =>
                                  setSelectedBuckets((previous) =>
                                    previous.includes(option.bucket)
                                      ? previous.filter(
                                          (bucket) => bucket !== option.bucket,
                                        )
                                      : [...previous, option.bucket],
                                  )
                                }
                              />
                              <span className="admin-panel__picker-option-label">
                                {option.bucket}
                              </span>
                              <span className="admin-panel__picker-option-extra">
                                {option.filteredCount.toLocaleString()}
                              </span>
                            </label>
                          ))
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div
                className="admin-panel__metrics-filters"
                role="tablist"
                aria-label="Metric activity filter"
              >
                <button
                  type="button"
                  className={`admin-panel__metrics-filter-btn ${
                    activityFilter === "all"
                      ? "admin-panel__metrics-filter-btn--active"
                      : ""
                  }`}
                  onClick={() => setActivityFilter("all")}
                >
                  All
                </button>
                <button
                  type="button"
                  className={`admin-panel__metrics-filter-btn ${
                    activityFilter === "active"
                      ? "admin-panel__metrics-filter-btn--active"
                      : ""
                  }`}
                  onClick={() => setActivityFilter("active")}
                >
                  Active
                </button>
                <button
                  type="button"
                  className={`admin-panel__metrics-filter-btn ${
                    activityFilter === "inactive"
                      ? "admin-panel__metrics-filter-btn--active"
                      : ""
                  }`}
                  onClick={() => setActivityFilter("inactive")}
                >
                  Inactive
                </button>
              </div>
            </div>
          </div>

          <div className="admin-panel__metrics-summary">
            <span className="admin-panel__metrics-summary-item">
              {totalCount.toLocaleString()} total
            </span>
            <span className="admin-panel__metrics-summary-item">
              {activeCount.toLocaleString()} active
            </span>
            {hasMultipleBuckets && (
              <span className="admin-panel__metrics-summary-item">
                {visibleBucketLabel}
              </span>
            )}
            <span
              className={`admin-panel__metrics-summary-item ${
                pendingCount > 0
                  ? "admin-panel__metrics-summary-item--warning"
                  : "admin-panel__metrics-summary-item--success"
              }`}
            >
              {pendingCount > 0
                ? `${pendingCount.toLocaleString()} pending descriptions`
                : "Descriptions ready"}
            </span>
          </div>
        </div>

        <div className="admin-panel__metrics-modal-body">
          {filteredRows.length === 0 ? (
            <div className="admin-panel__state-box">
              <span className="admin-panel__muted">
                {!hasAnyMetrics
                  ? "No metrics assigned."
                  : hasActiveFilters
                    ? "No metrics found for the current filters. Try changing the search, bucket, or activity filters."
                    : "No metrics available right now."}
              </span>
            </div>
          ) : (
            <>
              <div className="admin-panel__metrics-results-meta">
                Showing {visibleRows.length.toLocaleString()} of{" "}
                {filteredRows.length.toLocaleString()} metrics in{" "}
                {visibleBucketMetaLabel}
              </div>

              {visibleGroups.map(([bucket, group]) => (
                <section key={bucket} className="admin-panel__metrics-group-card">
                  <div className="admin-panel__metrics-group-header">
                    <span
                      className={`admin-panel__metrics-bucket-badge ${
                        focusedBucket === bucket
                          ? "admin-panel__metrics-bucket-badge--active"
                          : ""
                      }`}
                    >
                      {bucket}
                    </span>
                    <span className="admin-panel__muted">
                      {group.length.toLocaleString()} shown
                    </span>
                  </div>

                  <div className="admin-panel__metrics-group-table-wrap">
                    <table className="admin-panel__table">
                      <thead>
                        <tr>
                          <th className="admin-panel__th">Measurement</th>
                          <th className="admin-panel__th">Field</th>
                          <th className="admin-panel__th">Unit</th>
                          <th className="admin-panel__th">Description</th>
                          <th className="admin-panel__th">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.map((row) => (
                          <tr key={row.key} className="admin-panel__row">
                            <td className="admin-panel__td">
                              <code className="admin-panel__code-inline">
                                {row.measurement}
                              </code>
                            </td>
                            <td className="admin-panel__td">{row.field}</td>
                            <td className="admin-panel__td admin-panel__td--muted">
                              {row.unit ?? "-"}
                            </td>
                            <td className="admin-panel__td admin-panel__td--muted">
                              {row.description ?? "Pending"}
                            </td>
                            <td className="admin-panel__td">
                              <button
                                type="button"
                                className="admin-panel__btn admin-panel__btn--ghost"
                                onClick={() => {
                                  setEditingKey(row.key);
                                  setEditDesc(row.description ?? "");
                                }}
                              >
                                Edit
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ))}
            </>
          )}
        </div>

        <div className="admin-panel__modal-footer">
          {filteredRows.length > visibleRows.length && (
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              onClick={() =>
                setVisibleCount((current) => current + ROW_BATCH_SIZE)
              }
            >
              Load {Math.min(ROW_BATCH_SIZE, filteredRows.length - visibleRows.length)} more
            </button>
          )}

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
      </div>

      {editingKey && (
        <div
          className="admin-panel__modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="ap-edit-metric-title"
        >
          <div className="admin-panel__modal admin-panel__modal--wide">
            <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
              <MetricsIcon />
            </div>
            <h3 id="ap-edit-metric-title" className="admin-panel__modal-title">
              Edit description
            </h3>
            <p className="admin-panel__modal-desc">
              <code className="admin-panel__code-inline">{editingKey}</code>
            </p>

            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">Description</label>
              <textarea
                className="admin-panel__input"
                style={{ minHeight: 96, resize: "vertical" }}
                value={editDesc}
                onChange={(event) => setEditDesc(event.target.value)}
                placeholder="Enter a concise description for this metric..."
                disabled={saving}
              />
            </div>

            <div className="admin-panel__modal-actions" style={{ marginTop: 16 }}>
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--ghost"
                onClick={() => {
                  setEditingKey(null);
                  setEditDesc("");
                }}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="admin-panel__btn admin-panel__btn--primary"
                onClick={handleDescSave}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
