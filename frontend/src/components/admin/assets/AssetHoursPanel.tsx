import { useEffect, useState } from "react";
import {
  fetchAssetHours,
  setAssetHours,
  addAssetHoursReading,
  type AssetHoursConfig,
} from "../../../api/pmsApi";

interface MetricOption {
  id: string;
  label: string;
}

/**
 * Running-hours configuration + readings for one asset, shown atop the
 * asset PMS tab. Drives hours-based task status. Three sources: a direct
 * hours-counter metric, a power metric integrated from a baseline, or a
 * manual local counter read periodically.
 */
export function AssetHoursPanel({
  token,
  shipId,
  assetId,
  metricOptions,
}: {
  token: string | null;
  shipId: string;
  assetId: string;
  metricOptions: MetricOption[];
}) {
  const [cfg, setCfg] = useState<AssetHoursConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [reading, setReading] = useState("");
  const [readingNote, setReadingNote] = useState("");

  useEffect(() => {
    if (!token) return;
    let alive = true;
    void fetchAssetHours(token, shipId, assetId)
      .then((c) => alive && setCfg(c))
      .catch(() => alive && setCfg(null));
    return () => {
      alive = false;
    };
  }, [token, shipId, assetId]);

  const patch = async (next: Partial<AssetHoursConfig>) => {
    if (!token || !cfg) return;
    setSaving(true);
    try {
      setCfg(
        await setAssetHours(token, shipId, assetId, {
          source: next.source ?? cfg.source,
          metricCatalogId:
            next.metricCatalogId !== undefined
              ? next.metricCatalogId
              : cfg.metricCatalogId,
          baselineHours:
            next.baselineHours !== undefined
              ? next.baselineHours
              : cfg.baselineHours,
          baselineAt:
            next.baselineAt !== undefined ? next.baselineAt : cfg.baselineAt,
          runningThreshold:
            next.runningThreshold !== undefined
              ? next.runningThreshold
              : cfg.runningThreshold,
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  const submitReading = async () => {
    if (!token || !reading) return;
    setSaving(true);
    try {
      setCfg(
        await addAssetHoursReading(token, shipId, assetId, {
          hours: Number(reading),
          note: readingNote || null,
        }),
      );
      setReading("");
      setReadingNote("");
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) return null;
  const source = cfg.source;

  return (
    <div className="asset-hours">
      <div className="asset-hours__head">
        <span className="asset-hours__title">Running hours</span>
        <span className="asset-hours__current">
          {cfg.currentHours != null ? `${cfg.currentHours} h` : "—"}
        </span>
      </div>

      <label className="asset-hours__field">
        <span>Source</span>
        <select
          value={source}
          disabled={saving}
          onChange={(e) => void patch({ source: e.target.value as never })}
        >
          <option value="none">Not tracked</option>
          <option value="manual">Manual counter</option>
          <option value="metric_direct">Hours metric (direct)</option>
          <option value="metric_derived">Power metric (derived)</option>
        </select>
      </label>

      {(source === "metric_direct" || source === "metric_derived") && (
        <label className="asset-hours__field">
          <span>Metric</span>
          <select
            value={cfg.metricCatalogId ?? ""}
            disabled={saving}
            onChange={(e) =>
              void patch({ metricCatalogId: e.target.value || null })
            }
          >
            <option value="">Select metric…</option>
            {metricOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {source === "metric_derived" && (
        <div className="asset-hours__row">
          <label className="asset-hours__field">
            <span>Baseline hours</span>
            <input
              type="text"
              inputMode="decimal"
              value={cfg.baselineHours ?? ""}
              onBlur={(e) =>
                void patch({
                  baselineHours: e.target.value
                    ? Number(e.target.value)
                    : null,
                })
              }
              onChange={(e) =>
                setCfg({ ...cfg, baselineHours: e.target.value as never })
              }
              placeholder="hours before metric"
            />
          </label>
          <label className="asset-hours__field">
            <span>Baseline date</span>
            <input
              type="date"
              value={cfg.baselineAt ? cfg.baselineAt.slice(0, 10) : ""}
              onChange={(e) =>
                void patch({ baselineAt: e.target.value || null })
              }
            />
          </label>
          <label className="asset-hours__field">
            <span>Running &gt;</span>
            <input
              type="text"
              inputMode="decimal"
              value={cfg.runningThreshold}
              onBlur={(e) =>
                void patch({ runningThreshold: Number(e.target.value || 0) })
              }
              onChange={(e) =>
                setCfg({ ...cfg, runningThreshold: e.target.value as never })
              }
              placeholder="e.g. 100 (W)"
            />
          </label>
        </div>
      )}

      {source === "manual" && (
        <>
          <div className="asset-hours__row">
            <input
              className="asset-hours__reading"
              type="text"
              inputMode="decimal"
              placeholder="Reading (h)"
              value={reading}
              onChange={(e) => setReading(e.target.value.replace(/[^0-9.]/g, ""))}
            />
            <input
              className="asset-hours__reading"
              type="text"
              placeholder="Note"
              value={readingNote}
              onChange={(e) => setReadingNote(e.target.value)}
            />
            <button type="button" disabled={saving} onClick={submitReading}>
              Log
            </button>
          </div>
          {cfg.readings.length > 0 && (
            <div className="asset-hours__readings">
              {cfg.readings.slice(0, 5).map((r) => (
                <div key={r.id} className="asset-hours__reading-row">
                  <span>{r.readOn}</span>
                  <span>{r.hours} h</span>
                  {r.note && <span className="asset-hours__note">{r.note}</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
