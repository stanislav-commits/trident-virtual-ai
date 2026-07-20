import { useEffect, useMemo, useState } from "react";
import { XIcon } from "../AdminPanelIcons";
import {
  bulkSetAssetHours,
  fetchHoursOverview,
  type BulkHoursItem,
  type HoursMetricOption,
  type HoursOverview,
} from "../../../api/pmsApi";

const SOURCE_OPTIONS = [
  { value: "none", label: "No source" },
  { value: "manual", label: "Manual counter" },
  { value: "metric_direct", label: "Metric — hour counter" },
  { value: "metric_derived", label: "Metric — derived runtime" },
] as const;

interface Row {
  assetId: string;
  name: string;
  internalId: string | null;
  hoursTaskCount: number;
  sampleTasks: string[];
  /** Config as stored on the server (to detect edits). */
  origSource: string;
  origMetricId: string | null;
  source: string;
  metricId: string | null;
  suggested: boolean;
  suggestions: { metricId: string; score: number }[];
}

interface ApplyResult {
  ok: boolean;
  currentHours?: number | null;
  error?: string;
}

/**
 * Bulk asset↔hours-counter binding (phase C). Lists every asset that has an
 * hours-legged task (plus already-configured ones), pre-fills the best
 * hour-counter metric suggestion for unbound assets, and applies all edits in
 * one call — each applied row comes back with a LIVE hours reading as proof
 * the binding actually resolves.
 */
export function HoursBindingModal({
  token,
  shipId,
  onClose,
  onApplied,
}: {
  token: string;
  shipId: string;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [overview, setOverview] = useState<HoursOverview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Map<string, ApplyResult>>(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchHoursOverview(token, shipId);
        if (cancelled) return;
        setOverview(data);
        setRows(
          data.assets.map((a) => {
            // Pre-fill the top suggestion for assets with no source yet — the
            // operator reviews and applies instead of picking one by one.
            const top = a.suggestions[0]?.metricId ?? null;
            const prefill = a.source === "none" && top != null;
            return {
              assetId: a.assetId,
              name: a.name,
              internalId: a.internalId,
              hoursTaskCount: a.hoursTaskCount,
              sampleTasks: a.sampleTasks,
              origSource: a.source,
              origMetricId: a.metricCatalogId,
              source: prefill ? "metric_direct" : a.source,
              metricId: prefill ? top : a.metricCatalogId,
              suggested: prefill,
              suggestions: a.suggestions,
            };
          }),
        );
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, shipId]);

  const metricById = useMemo(() => {
    const m = new Map<string, HoursMetricOption>();
    for (const opt of overview?.metricPool ?? []) m.set(opt.id, opt);
    return m;
  }, [overview]);

  const patch = (assetId: string, next: Partial<Row>) =>
    setRows((rs) =>
      rs.map((r) =>
        r.assetId === assetId ? { ...r, ...next, suggested: false } : r,
      ),
    );

  const isDirty = (r: Row) =>
    r.source !== r.origSource ||
    (r.source.startsWith("metric") && r.metricId !== r.origMetricId);

  const dirtyRows = rows.filter(isDirty);
  const invalidDirty = dirtyRows.filter(
    (r) => r.source.startsWith("metric") && !r.metricId,
  );

  const apply = async () => {
    if (dirtyRows.length === 0 || invalidDirty.length > 0) return;
    setBusy(true);
    setError(null);
    try {
      const items: BulkHoursItem[] = dirtyRows.map((r) => ({
        assetId: r.assetId,
        source: r.source,
        metricCatalogId: r.source.startsWith("metric") ? r.metricId : null,
      }));
      const res = await bulkSetAssetHours(token, shipId, items);
      const map = new Map<string, ApplyResult>();
      for (const item of res.results) {
        map.set(item.assetId, {
          ok: item.ok,
          currentHours: item.currentHours,
          error: item.error,
        });
      }
      setResults(map);
      // Applied rows become the new baseline so remaining edits stay dirty.
      setRows((rs) =>
        rs.map((r) =>
          map.get(r.assetId)?.ok
            ? { ...r, origSource: r.source, origMetricId: r.metricId }
            : r,
        ),
      );
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Apply failed");
    } finally {
      setBusy(false);
    }
  };

  const metricLabel = (id: string) => {
    const m = metricById.get(id);
    if (!m) return id;
    return m.unit ? `${m.label} (${m.unit})` : m.label;
  };

  const resultCell = (r: Row) => {
    const res = results.get(r.assetId);
    if (res) {
      if (!res.ok)
        return (
          <span className="pms__import-warn" title={res.error}>
            ✗ failed
          </span>
        );
      if (r.source === "none") return <span>cleared</span>;
      if (res.currentHours != null)
        return <span title="Live reading — the binding resolves">✓ {res.currentHours} h</span>;
      return (
        <span
          className="pms__import-warn"
          title={
            r.source === "manual"
              ? "Saved — no reading logged yet; a monthly reminder task was created"
              : "Saved, but the metric returned no data — check the metric choice"
          }
        >
          {r.source === "manual" ? "✓ awaiting reading" : "⚠ no data"}
        </span>
      );
    }
    if (isDirty(r))
      return (
        <span className="pms__import-muted">
          {r.suggested ? "suggested" : "edited"}
        </span>
      );
    if (r.origSource !== "none")
      return <span className="pms__import-muted">configured</span>;
    return <span className="pms__import-muted">—</span>;
  };

  return (
    <div className="admin-panel__modal-overlay" onClick={onClose}>
      <div
        className="admin-panel__modal pms__import-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-panel__modal-header">
          <h3>Running-hours sources</h3>
          <button
            type="button"
            className="admin-panel__icon-btn"
            onClick={onClose}
          >
            <XIcon />
          </button>
        </div>

        {overview && (
          <div className="pms__import-summary">
            <span>
              {rows.length} asset{rows.length === 1 ? "" : "s"} with hour-based
              tasks
            </span>
            <span>
              · {rows.filter((r) => r.origSource !== "none").length} configured
            </span>
            {dirtyRows.length > 0 && (
              <span>· {dirtyRows.length} pending change{dirtyRows.length === 1 ? "" : "s"}</span>
            )}
          </div>
        )}
        {error && <div className="pms__import-note">{error}</div>}
        {!overview && !error && (
          <div className="pms__import-note">Loading…</div>
        )}
        {overview && rows.length === 0 && (
          <div className="pms__import-note">
            No assets have hour-interval tasks yet — import or create a task
            with an hours interval first.
          </div>
        )}

        {rows.length > 0 && (
          <div className="pms__import-table-wrap">
            <table className="pms__table pms__import-table">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Hour tasks</th>
                  <th>Source</th>
                  <th>Metric</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const suggestionIds = new Set(
                    r.suggestions.map((s) => s.metricId),
                  );
                  return (
                    <tr key={r.assetId}>
                      <td>
                        {r.name}
                        {r.internalId && (
                          <div className="pms__import-ref">{r.internalId}</div>
                        )}
                      </td>
                      <td
                        className="pms__import-muted"
                        title={r.sampleTasks.join("\n")}
                      >
                        {r.hoursTaskCount > 0 ? r.hoursTaskCount : "—"}
                      </td>
                      <td>
                        <select
                          className="pms__import-input"
                          value={r.source}
                          onChange={(e) =>
                            patch(r.assetId, {
                              source: e.target.value,
                              metricId: e.target.value.startsWith("metric")
                                ? (r.metricId ??
                                  r.suggestions[0]?.metricId ??
                                  null)
                                : r.metricId,
                            })
                          }
                          title={
                            r.source === "manual"
                              ? "Crew logs the gauge reading; a monthly reminder task keeps it fresh"
                              : undefined
                          }
                        >
                          {SOURCE_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {r.source.startsWith("metric") ? (
                          <select
                            className="pms__import-input"
                            value={r.metricId ?? ""}
                            onChange={(e) =>
                              patch(r.assetId, {
                                metricId: e.target.value || null,
                              })
                            }
                          >
                            <option value="">— pick a metric —</option>
                            {r.suggestions.length > 0 && (
                              <optgroup label="Suggested">
                                {r.suggestions.map((s) => (
                                  <option key={s.metricId} value={s.metricId}>
                                    {metricLabel(s.metricId)}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            <optgroup label="All hour-counter metrics">
                              {(overview?.metricPool ?? [])
                                .filter((m) => !suggestionIds.has(m.id))
                                .map((m) => (
                                  <option key={m.id} value={m.id}>
                                    {metricLabel(m.id)}
                                  </option>
                                ))}
                            </optgroup>
                          </select>
                        ) : (
                          <span className="pms__import-muted">—</span>
                        )}
                      </td>
                      <td>{resultCell(r)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="admin-panel__modal-actions">
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--ghost"
            onClick={onClose}
            disabled={busy}
          >
            Close
          </button>
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--primary"
            onClick={apply}
            disabled={
              busy || dirtyRows.length === 0 || invalidDirty.length > 0
            }
            title={
              invalidDirty.length > 0
                ? "Some rows use a metric source without a metric picked"
                : undefined
            }
          >
            {busy
              ? "Applying…"
              : `Apply ${dirtyRows.length} binding${dirtyRows.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
