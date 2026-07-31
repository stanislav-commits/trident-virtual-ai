import { createPortal } from "react-dom";
import type { RelatedAssetResult } from "../../../../api/assetsApi";
import type {
  PmsImportDraft,
  PmsImportPreview,
  PmsTaskDto,
} from "../../../../api/pmsApi";
import { AssetHoursPanel } from "../AssetHoursPanel";
import { ImportPreviewModal } from "../../PmsSection";
import { StatusBadge } from "../../StatusBadge";
import { deriveDue, deriveHours } from "../../pms/taskTypes";

/**
 * Planned maintenance for this asset, plus its running hours.
 *
 * A task can be due on the calendar AND on hours; it falls due on whichever
 * comes first, so both legs are shown — a calendar leg can be overdue while
 * the hours still have slack, and showing only the winner hides that.
 */
export function AssetPmsTab({
  token,
  shipId,
  assetId,
  related,
  serviceRules,
  manualFileName,
  busy,
  preview,
  onSuggest,
  onCancelPreview,
  onConfirmPreview,
}: {
  token: string | null;
  shipId: string;
  assetId: string;
  related: RelatedAssetResult | null;
  serviceRules: PmsTaskDto[] | null;
  manualFileName: string | null;
  busy: boolean;
  preview: PmsImportPreview | null;
  onSuggest: () => void;
  onCancelPreview: () => void;
  onConfirmPreview: (drafts: PmsImportDraft[]) => Promise<void>;
}) {
  return (
  <div className="assets-section__drawer-section">
    <AssetHoursPanel
      token={token}
      shipId={shipId}
      assetId={assetId}
      metricOptions={(related?.metrics ?? []).map((m) => ({
        id: m.id,
        label: `${m.measurement}.${m.field}`,
      }))}
    />

    <div className="assets-section__pms-suggest">
      <button
        type="button"
        className="pms__btn"
        disabled={!manualFileName || busy}
        onClick={onSuggest}
        title={
          manualFileName
            ? `Propose maintenance tasks from ${manualFileName}`
            : "Link a manual to this asset first (Manuals tab)"
        }
      >
        {busy
          ? "Reading manual…"
          : manualFileName
            ? "Suggest PMS from manual"
            : "Suggest PMS (no manual linked)"}
      </button>
    </div>

    {preview &&
      createPortal(
        <ImportPreviewModal
          preview={preview}
          busy={busy}
          onCancel={onCancelPreview}
          onConfirm={onConfirmPreview}
        />,
        document.body,
      )}

    {serviceRules === null && (
      <div className="assets-section__placeholder">Loading…</div>
    )}
    {serviceRules !== null && serviceRules.length === 0 && (
      <div className="assets-section__placeholder">
        No maintenance tasks linked to this asset yet. Add tasks in the
        Tasks section and link this asset.
      </div>
    )}
    {serviceRules?.map((t) => {
      const variant =
        t.status === "due-soon" ? "upcoming" : t.status;
      const label =
        t.status === "overdue"
          ? "OVERDUE"
          : t.status === "due-soon"
            ? "DUE SOON"
            : "OK";
      const isReminder = t.source === "hours_reminder";
      // Dual-interval tasks (calendar AND hours) are due on WHICHEVER
      // comes first — show both sides, not just the winning one, so it's
      // clear when e.g. a calendar leg is overdue while hours still have
      // slack (or vice versa). Falls back to the single-dimension `due`.
      const calendarText =
        !isReminder && t.dueDate ? deriveDue(t.dueDate).due : null;
      const hoursText = isReminder
        ? null
        : t.currentHours != null && t.dueHours != null
          ? deriveHours(t.currentHours, t.dueHours).due
          : t.intervalHours != null
            ? "awaiting metric"
            : null;
      const dueLine = isReminder
        ? `${t.due} · monthly reading`
        : [calendarText, hoursText].filter(Boolean).join(" · ") || t.due;
      return (
        <div key={t.id} className="assets-section__pms-row">
          <div className="assets-section__pms-main">
            <span className="assets-section__pms-name">
              {isReminder ? "🕐" : "🔧"} {t.task}
            </span>
            <span className="assets-section__pms-due">
              {dueLine}
              {t.assigneeName ? ` · ${t.assigneeName}` : ""}
            </span>
          </div>
          <StatusBadge base="assets-section__pms-badge" variant={variant}>
            {label}
          </StatusBadge>
        </div>
      );
    })}
  </div>
  );
}
