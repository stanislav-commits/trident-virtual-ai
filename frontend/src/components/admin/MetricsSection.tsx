import { useState } from "react";
import {
  createMetric,
  updateMetric,
  deleteMetric,
  type MetricDefinitionItem,
} from "../../api/client";
import { MetricsIcon, XIcon, PlusIcon } from "./AdminPanelIcons";

interface MetricsSectionProps {
  token: string | null;
  metrics: MetricDefinitionItem[];
  loading: boolean;
  error: string;
  onLoadMetrics: () => Promise<void>;
  onMetricDeleteSuccess?: () => void;
  onError: (error: string) => void;
}

interface MetricForm {
  key: string;
  label: string;
  description: string;
  unit: string;
  dataType: string;
}

interface DeleteConfirm {
  key: string;
  label: string;
}

export function MetricsSection({
  token,
  metrics,
  loading,
  onLoadMetrics,
  onMetricDeleteSuccess,
  onError,
}: MetricsSectionProps) {
  const [metricForm, setMetricForm] = useState<MetricForm>({
    key: "",
    label: "",
    description: "",
    unit: "",
    dataType: "numeric",
  });
  const [creatingMetric, setCreatingMetric] = useState(false);
  const [editingMetricKey, setEditingMetricKey] = useState<string | null>(null);
  const [metricDeleteConfirm, setMetricDeleteConfirm] =
    useState<DeleteConfirm | null>(null);
  const [deletingMetricKey, setDeletingMetricKey] = useState<string | null>(
    null,
  );

  const handleMetricCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !metricForm.key.trim() || !metricForm.label.trim()) return;
    setCreatingMetric(true);
    onError("");
    try {
      await createMetric(
        {
          key: metricForm.key.trim(),
          label: metricForm.label.trim(),
          description: metricForm.description.trim() || undefined,
          unit: metricForm.unit.trim() || undefined,
          dataType: metricForm.dataType.trim() || "numeric",
        },
        token,
      );
      setMetricForm({
        key: "",
        label: "",
        description: "",
        unit: "",
        dataType: "numeric",
      });
      await onLoadMetrics();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create metric");
    } finally {
      setCreatingMetric(false);
    }
  };

  const handleMetricEdit = (m: MetricDefinitionItem) => {
    setEditingMetricKey(m.key);
    setMetricForm({
      key: m.key,
      label: m.label,
      description: m.description ?? "",
      unit: m.unit ?? "",
      dataType: m.dataType ?? "numeric",
    });
  };

  const handleMetricEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !editingMetricKey || !metricForm.label.trim()) return;
    setCreatingMetric(true);
    onError("");
    try {
      await updateMetric(
        editingMetricKey,
        {
          label: metricForm.label.trim(),
          description: metricForm.description.trim() || undefined,
          unit: metricForm.unit.trim() || undefined,
          dataType: metricForm.dataType.trim() || "numeric",
        },
        token,
      );
      setEditingMetricKey(null);
      setMetricForm({
        key: "",
        label: "",
        description: "",
        unit: "",
        dataType: "numeric",
      });
      await onLoadMetrics();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update metric");
    } finally {
      setCreatingMetric(false);
    }
  };

  const handleMetricDeleteClick = (key: string, label: string) =>
    setMetricDeleteConfirm({ key, label });
  const handleMetricDeleteCancel = () => setMetricDeleteConfirm(null);

  const handleMetricDeleteConfirm = async () => {
    if (!token || !metricDeleteConfirm) return;
    setDeletingMetricKey(metricDeleteConfirm.key);
    onError("");
    setMetricDeleteConfirm(null);
    try {
      await deleteMetric(metricDeleteConfirm.key, token);
      await onLoadMetrics();
      onMetricDeleteSuccess?.();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete metric");
    } finally {
      setDeletingMetricKey(null);
    }
  };

  return (
    <>
      <section className="admin-panel__section">
        <div className="admin-panel__section-head">
          <div>
            <h2 className="admin-panel__section-title">Metrics</h2>
            <p className="admin-panel__section-subtitle">
              Define metric keys, display names and descriptions for ship
              telemetry.
            </p>
          </div>
          {editingMetricKey ? (
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              onClick={() => {
                setEditingMetricKey(null);
                setMetricForm({
                  key: "",
                  label: "",
                  description: "",
                  unit: "",
                  dataType: "numeric",
                });
              }}
            >
              Cancel edit
            </button>
          ) : null}
        </div>

        {editingMetricKey ? (
          <div className="admin-panel__form-card">
            <h3 className="admin-panel__form-card-title">Edit metric</h3>
            <form
              onSubmit={handleMetricEditSubmit}
              className="admin-panel__ship-form"
            >
              <div className="admin-panel__field">
                <label className="admin-panel__field-label">
                  Key (read-only)
                </label>
                <input
                  type="text"
                  value={metricForm.key}
                  readOnly
                  className="admin-panel__input admin-panel__input--readonly"
                />
              </div>
              <div className="admin-panel__form-row">
                <div className="admin-panel__field">
                  <label className="admin-panel__field-label">
                    Display name
                  </label>
                  <input
                    type="text"
                    value={metricForm.label}
                    onChange={(e) =>
                      setMetricForm((p) => ({
                        ...p,
                        label: e.target.value,
                      }))
                    }
                    className="admin-panel__input"
                    placeholder="e.g. Speed"
                    required
                    disabled={creatingMetric}
                  />
                </div>
                <div className="admin-panel__field">
                  <label className="admin-panel__field-label">Unit</label>
                  <input
                    type="text"
                    value={metricForm.unit}
                    onChange={(e) =>
                      setMetricForm((p) => ({
                        ...p,
                        unit: e.target.value,
                      }))
                    }
                    className="admin-panel__input"
                    placeholder="e.g. knots"
                    disabled={creatingMetric}
                  />
                </div>
              </div>
              <div className="admin-panel__field">
                <label className="admin-panel__field-label">
                  Description (what this metric means)
                </label>
                <textarea
                  value={metricForm.description}
                  onChange={(e) =>
                    setMetricForm((p) => ({
                      ...p,
                      description: e.target.value,
                    }))
                  }
                  className="admin-panel__input admin-panel__textarea"
                  placeholder="Optional description"
                  rows={3}
                  disabled={creatingMetric}
                />
              </div>
              <div className="admin-panel__form-actions">
                <button
                  type="submit"
                  className="admin-panel__btn admin-panel__btn--primary"
                  disabled={creatingMetric}
                >
                  {creatingMetric ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div className="admin-panel__form-card">
            <h3 className="admin-panel__form-card-title">New metric</h3>
            <form
              onSubmit={handleMetricCreate}
              className="admin-panel__ship-form"
            >
              <div className="admin-panel__form-row">
                <div className="admin-panel__field">
                  <label className="admin-panel__field-label">Key</label>
                  <input
                    type="text"
                    value={metricForm.key}
                    onChange={(e) =>
                      setMetricForm((p) => ({
                        ...p,
                        key: e.target.value,
                      }))
                    }
                    className="admin-panel__input"
                    placeholder="e.g. speed_knots"
                    required
                    disabled={creatingMetric}
                  />
                </div>
                <div className="admin-panel__field">
                  <label className="admin-panel__field-label">
                    Display name
                  </label>
                  <input
                    type="text"
                    value={metricForm.label}
                    onChange={(e) =>
                      setMetricForm((p) => ({
                        ...p,
                        label: e.target.value,
                      }))
                    }
                    className="admin-panel__input"
                    placeholder="e.g. Speed"
                    required
                    disabled={creatingMetric}
                  />
                </div>
              </div>
              <div className="admin-panel__field">
                <label className="admin-panel__field-label">
                  Description (what this metric means)
                </label>
                <textarea
                  value={metricForm.description}
                  onChange={(e) =>
                    setMetricForm((p) => ({
                      ...p,
                      description: e.target.value,
                    }))
                  }
                  className="admin-panel__input admin-panel__textarea"
                  placeholder="Optional"
                  rows={3}
                  disabled={creatingMetric}
                />
              </div>
              <div className="admin-panel__form-row">
                <div className="admin-panel__field">
                  <label className="admin-panel__field-label">Unit</label>
                  <input
                    type="text"
                    value={metricForm.unit}
                    onChange={(e) =>
                      setMetricForm((p) => ({
                        ...p,
                        unit: e.target.value,
                      }))
                    }
                    className="admin-panel__input"
                    placeholder="e.g. knots"
                    disabled={creatingMetric}
                  />
                </div>
                <div className="admin-panel__field">
                  <label className="admin-panel__field-label">Data type</label>
                  <select
                    value={metricForm.dataType}
                    onChange={(e) =>
                      setMetricForm((p) => ({
                        ...p,
                        dataType: e.target.value,
                      }))
                    }
                    className="admin-panel__select"
                    disabled={creatingMetric}
                  >
                    <option value="numeric">numeric</option>
                    <option value="string">string</option>
                    <option value="boolean">boolean</option>
                  </select>
                </div>
              </div>
              <div className="admin-panel__form-actions">
                <button
                  type="submit"
                  className="admin-panel__btn admin-panel__btn--primary"
                  disabled={creatingMetric}
                >
                  <PlusIcon />
                  {creatingMetric ? "Creating…" : "Create metric"}
                </button>
              </div>
            </form>
          </div>
        )}

        {loading ? (
          <div className="admin-panel__state-box">
            <div className="admin-panel__spinner" />
            <span className="admin-panel__muted">Loading metrics…</span>
          </div>
        ) : metrics.length === 0 ? (
          <div className="admin-panel__state-box">
            <MetricsIcon />
            <span className="admin-panel__muted">No metrics yet.</span>
          </div>
        ) : (
          <div className="admin-panel__card">
            <table className="admin-panel__table">
              <thead>
                <tr>
                  <th className="admin-panel__th">Key</th>
                  <th className="admin-panel__th">Display name</th>
                  <th className="admin-panel__th">Description</th>
                  <th className="admin-panel__th">Unit</th>
                  <th className="admin-panel__th">Type</th>
                  <th className="admin-panel__th">Actions</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => (
                  <tr key={m.key} className="admin-panel__row">
                    <td className="admin-panel__td admin-panel__td--key">
                      <code className="admin-panel__code-inline">{m.key}</code>
                    </td>
                    <td className="admin-panel__td">{m.label}</td>
                    <td className="admin-panel__td admin-panel__td--desc">
                      {m.description ?? "—"}
                    </td>
                    <td className="admin-panel__td">{m.unit ?? "—"}</td>
                    <td className="admin-panel__td">
                      {m.dataType ?? "numeric"}
                    </td>
                    <td className="admin-panel__td">
                      <div className="admin-panel__actions">
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--ghost"
                          onClick={() => handleMetricEdit(m)}
                          disabled={
                            !!editingMetricKey || deletingMetricKey === m.key
                          }
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--danger"
                          onClick={() =>
                            handleMetricDeleteClick(m.key, m.label)
                          }
                          disabled={
                            !!editingMetricKey || deletingMetricKey === m.key
                          }
                        >
                          {deletingMetricKey === m.key ? "…" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {metricDeleteConfirm && (
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-metric-delete-title"
          >
            <div className="admin-panel__modal">
              <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
                <XIcon />
              </div>
              <h2
                id="ap-metric-delete-title"
                className="admin-panel__modal-title"
              >
                Delete this metric?
              </h2>
              <p className="admin-panel__modal-desc">
                Metric{" "}
                <code className="admin-panel__code">
                  {metricDeleteConfirm.key}
                </code>{" "}
                ({metricDeleteConfirm.label}) will be removed. This cannot be
                undone. It can only be deleted if no ship uses it.
              </p>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--ghost"
                  onClick={handleMetricDeleteCancel}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--danger"
                  onClick={handleMetricDeleteConfirm}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
