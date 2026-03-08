import { useState } from "react";
import type {
  ShipMetricsConfigItem,
  MetricDefinitionItem,
} from "../../api/client";
import { updateMetric } from "../../api/client";
import { MetricsIcon, XIcon, SearchIcon } from "./AdminPanelIcons";

/** Parse a composite key like "Trending::MEAS_NAME::fieldName" */
function parseMetricKey(key: string) {
  const parts = key.split("::");
  if (parts.length === 3) {
    return { bucket: parts[0], measurement: parts[1], field: parts[2] };
  }
  return { bucket: "—", measurement: key, field: "—" };
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
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDesc, setEditDesc] = useState("");
  const [saving, setSaving] = useState(false);

  const defMap = new Map(metricDefinitions.map((d) => [d.key, d]));

  const handleDescSave = async () => {
    if (!token || !editingKey) return;
    setSaving(true);
    try {
      await updateMetric(editingKey, { description: editDesc }, token);
      onDefinitionsChanged?.();
      setEditingKey(null);
      setEditDesc("");
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Failed to save description",
      );
    } finally {
      setSaving(false);
    }
  };

  const rows = metricsConfig.map((c) => {
    const def = defMap.get(c.metricKey);
    const parsed = parseMetricKey(c.metricKey);
    return {
      key: c.metricKey,
      bucket: def?.bucket ?? parsed.bucket,
      measurement: def?.measurement ?? parsed.measurement,
      field: def?.field ?? parsed.field,
      description: def?.description ?? null,
      unit: def?.unit ?? null,
      status: def?.status ?? "active",
    };
  });

  const filtered = search.trim()
    ? rows.filter((r) => {
        const q = search.toLowerCase();
        return (
          r.measurement.toLowerCase().includes(q) ||
          r.field.toLowerCase().includes(q) ||
          (r.description?.toLowerCase().includes(q) ?? false) ||
          r.bucket.toLowerCase().includes(q)
        );
      })
    : rows;

  // Group by bucket
  const buckets = [...new Set(filtered.map((r) => r.bucket))].sort();

  return (
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ap-metrics-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="admin-panel__modal admin-panel__modal--wide"
        style={{ maxWidth: 1000 }}
      >
        <button
          type="button"
          className="admin-panel__modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          <XIcon />
        </button>
        <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
          <MetricsIcon />
        </div>
        <h2 id="ap-metrics-modal-title" className="admin-panel__modal-title">
          Metrics for &ldquo;{shipName}&rdquo;
        </h2>
        <p className="admin-panel__modal-desc">
          {rows.length} metric{rows.length !== 1 ? "s" : ""} assigned to this
          ship, grouped by bucket.
        </p>

        {/* Search */}
        <div className="admin-panel__metrics-search">
          <SearchIcon />
          <input
            type="text"
            className="admin-panel__metrics-search-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter metrics…"
          />
        </div>

        <div style={{ maxHeight: "60vh", overflowY: "auto", paddingRight: 4 }}>
          {filtered.length === 0 ? (
            <div
              className="admin-panel__state-box"
              style={{ margin: "24px 0" }}
            >
              <span className="admin-panel__muted">
                {search
                  ? "No metrics match your filter."
                  : "No metrics assigned."}
              </span>
            </div>
          ) : (
            buckets.map((bucket) => {
              const group = filtered.filter((r) => r.bucket === bucket);
              return (
                <div key={bucket} className="admin-panel__metrics-group">
                  <div className="admin-panel__metrics-group-header">
                    <span className="admin-panel__metrics-bucket-badge">
                      {bucket}
                    </span>
                    <span
                      className="admin-panel__muted"
                      style={{ fontSize: "0.75rem" }}
                    >
                      {group.length} metric{group.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <table className="admin-panel__table">
                    <thead>
                      <tr>
                        <th className="admin-panel__th">Measurement</th>
                        <th className="admin-panel__th">Field</th>
                        <th className="admin-panel__th">Unit</th>
                        <th className="admin-panel__th">Description</th>
                        <th className="admin-panel__th" style={{ width: 80 }}>
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.map((r) => (
                        <tr key={r.key} className="admin-panel__row">
                          <td className="admin-panel__td">
                            <code className="admin-panel__code-inline">
                              {r.measurement}
                            </code>
                          </td>
                          <td className="admin-panel__td">{r.field}</td>
                          <td className="admin-panel__td admin-panel__td--muted">
                            {r.unit ?? "—"}
                          </td>
                          <td className="admin-panel__td admin-panel__td--muted">
                            {r.description ?? "—"}
                          </td>
                          <td className="admin-panel__td">
                            <button
                              type="button"
                              className="admin-panel__btn admin-panel__btn--ghost"
                              style={{
                                padding: "4px 10px",
                                fontSize: "0.75rem",
                              }}
                              onClick={() => {
                                setEditingKey(r.key);
                                setEditDesc(r.description ?? "");
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
              );
            })
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

      {/* ── Edit description sub-modal ── */}
      {editingKey && (
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
          <div className="admin-panel__modal" style={{ maxWidth: 480 }}>
            <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
              <MetricsIcon />
            </div>
            <h3 className="admin-panel__modal-title">Edit description</h3>
            <p
              className="admin-panel__modal-desc"
              style={{ wordBreak: "break-word" }}
            >
              <code className="admin-panel__code-inline">{editingKey}</code>
            </p>
            <div className="admin-panel__modal-field" style={{ marginTop: 8 }}>
              <label className="admin-panel__field-label">Description</label>
              <textarea
                className="admin-panel__input"
                style={{ minHeight: 80, resize: "vertical" }}
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Enter a description for this metric…"
                disabled={saving}
              />
            </div>
            <div
              className="admin-panel__modal-actions"
              style={{ marginTop: 16 }}
            >
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
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
