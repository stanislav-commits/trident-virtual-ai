import { BindMetricPicker } from "../BindMetricPicker";
import { EditableCell } from "../EditableCell";
import type { RelatedAssetResult } from "../../../../api/assetsApi";

/**
 * Telemetry bound to this asset.
 *
 * The confidence badge is the point of the list: a binding is AI-proposed
 * until a human touches it, and 100% means someone confirmed it. Unbinding is
 * one click because a wrong binding sends the wrong readings to chat.
 */
export function AssetMetricsTab({
  token,
  shipId,
  assetId,
  related,
  relatedLoading,
  pickerOpen,
  onTogglePicker,
  onClosePicker,
  onRefreshRelated,
  unbindingId,
  onUnbind,
  onUpdateUnit,
}: {
  token: string | null;
  shipId: string;
  assetId: string;
  related: RelatedAssetResult | null;
  relatedLoading: boolean;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onClosePicker: () => void;
  onRefreshRelated: () => Promise<void> | void;
  unbindingId: string | null;
  onUnbind: (metricId: string) => void;
  onUpdateUnit: (metricId: string, next: string | null) => Promise<void>;
}) {
  return (
  <div className="assets-section__drawer-section">
    <div className="assets-section__drawer-section-head">
      Bound metrics
      <button
        type="button"
        className="assets-section__drawer-section-btn"
        onClick={onTogglePicker}
        title="Pick from the ship's catalog and bind to this asset"
      >
        {pickerOpen ? "× Cancel" : "+ Add"}
      </button>
    </div>
    <div className="assets-section__drawer-section-note">
      AI-bound by gpt-4o · 100% = human-verified · click × to unbind
    </div>
    {pickerOpen && (
      <BindMetricPicker
        token={token}
        shipId={shipId}
        currentAssetId={assetId}
        alreadyBoundIds={new Set((related?.metrics ?? []).map((m) => m.id))}
        onClose={onClosePicker}
        onBound={() => {
          void onRefreshRelated();
        }}
      />
    )}
    {relatedLoading && (
      <div className="assets-section__placeholder">Loading…</div>
    )}
    {!relatedLoading && related && related.metrics.length === 0 && (
      <div className="assets-section__placeholder">
        No metrics bound yet. Run{" "}
        <code>POST /metrics/ships/:id/analyze</code> after import.
      </div>
    )}
    {!relatedLoading &&
      related &&
      related.metrics.map((m) => {
        const conf =
          typeof m.aiBoundConfidence === "number"
            ? Math.round(m.aiBoundConfidence * 100)
            : null;
        const confLevel =
          conf === null
            ? "unknown"
            : conf >= 100
              ? "verified"
              : conf >= 80
                ? "high"
                : conf >= 60
                  ? "medium"
                  : "low";
        return (
          <div
            key={m.id}
            className="assets-section__metric-row"
            title={m.aiDescription ?? undefined}
          >
            <span className="assets-section__metric-name">
              {m.measurement}.{m.field}
            </span>
            {conf !== null && (
              <span
                className={`assets-section__metric-conf assets-section__metric-conf--${confLevel}`}
                title={
                  conf === 100
                    ? "Human-verified binding"
                    : `AI confidence ${conf}%`
                }
              >
                {conf === 100 ? "✓" : `${conf}%`}
              </span>
            )}
            <span className="assets-section__metric-unit">
              <EditableCell
                value={m.aiUnit}
                placeholder={m.aiKind ?? "—"}
                onSave={(next) => onUpdateUnit(m.id, next)}
              />
            </span>
            <button
              type="button"
              className="assets-section__metric-unbind"
              onClick={() => onUnbind(m.id)}
              disabled={unbindingId === m.id}
              aria-label={`Unbind ${m.measurement}.${m.field}`}
              title="Unbind from this asset"
            >
              {unbindingId === m.id ? "…" : "×"}
            </button>
          </div>
        );
      })}
  </div>
  );
}
