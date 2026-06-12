import { useCallback, useEffect, useState } from "react";
import {
  unlinkAssetDocument,
  updateMetricBinding,
  updateMetricUnit,
  type AssetItem,
  type AssetServiceRule,
  type RelatedAssetResult,
  type UpdateAssetInput,
} from "../../../api/assetsApi";
import type { AssetComplianceRecord } from "../../../api/complianceApi";
import { fetchDocumentFile } from "../../../api/documentsApi";
import { StatusBadge } from "../StatusBadge";
import { BindMetricPicker } from "./BindMetricPicker";
import { EditableCell } from "./EditableCell";
import { LinkManualPicker } from "./LinkManualPicker";

type DrawerTab = "overview" | "metrics" | "manuals" | "pms" | "certs";

/**
 * Client-side PMS verdict on the calendar axis only (the hours axis
 * needs a live runtime counter — backend find_pms_due owns that logic).
 * OVERDUE: months interval elapsed since last-done. UPCOMING: due within
 * 30 days. OK: due later. UNKNOWN: no last-done baseline or no
 * calendar interval.
 */
function ruleVerdict(rule: AssetServiceRule): {
  label: string;
  level: "overdue" | "upcoming" | "ok" | "unknown";
  due: string | null;
} {
  if (!rule.lastDoneAt || rule.intervalMonths == null) {
    return { label: "UNKNOWN", level: "unknown", due: null };
  }
  const due = new Date(rule.lastDoneAt);
  due.setMonth(due.getMonth() + rule.intervalMonths);
  const dueStr = due.toISOString().slice(0, 10);
  const days = (due.getTime() - Date.now()) / 86_400_000;
  if (days < 0) return { label: "OVERDUE", level: "overdue", due: dueStr };
  if (days <= 30) return { label: "UPCOMING", level: "upcoming", due: dueStr };
  return { label: "OK", level: "ok", due: dueStr };
}

/**
 * One labelled row in the overview "full details" grid. Declared at MODULE
 * level on purpose: defining it inside the render function recreates its
 * type every render, React unmounts/remounts the EditableCell input, and
 * focus is lost mid-edit (the known "can't type more than one character"
 * bug in this codebase).
 */
function OverviewFieldRow({
  label,
  value,
  onSave,
  placeholder,
  width,
}: {
  label: string;
  value: string | null;
  /** When present the field is editable; otherwise read-only. */
  onSave?: (next: string | null) => Promise<void> | void;
  placeholder?: string;
  width?: "full" | "half";
}) {
  return (
    <div
      className={`assets-section__field assets-section__field--${
        width ?? "half"
      }`}
    >
      <span className="assets-section__field-label">{label}</span>
      {onSave ? (
        <EditableCell
          value={value}
          placeholder={placeholder ?? "—"}
          onSave={onSave}
        />
      ) : (
        <span className="assets-section__field-readonly">{value ?? "—"}</span>
      )}
    </div>
  );
}

export interface AssetDrawerProps {
  token: string | null;
  shipId: string;
  asset: AssetItem;
  related: RelatedAssetResult | null;
  relatedLoading: boolean;
  serviceRules: AssetServiceRule[] | null;
  assetCerts: AssetComplianceRecord[] | null;
  onClose: () => void;
  /** Re-fetch bound metrics + linked documents after a mutation. */
  onRefreshRelated: () => Promise<void>;
  onError: (message: string) => void;
  /**
   * Inline-edit save handler factory shared with the main table — returns
   * the per-field saver for the given asset.
   */
  makeFieldSaver: (
    assetId: string,
    field: keyof UpdateAssetInput,
  ) => (next: string | null) => Promise<void>;
}

/**
 * Right drawer — asset detail. V2-style tabbed layout:
 * Overview | Metrics | Manuals | PMS | Certs.
 */
export function AssetDrawer({
  token,
  shipId,
  asset,
  related,
  relatedLoading,
  serviceRules,
  assetCerts,
  onClose,
  onRefreshRelated,
  onError,
  makeFieldSaver,
}: AssetDrawerProps) {
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("overview");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manualPickerOpen, setManualPickerOpen] = useState(false);
  const [unbindingId, setUnbindingId] = useState<string | null>(null);
  const [unlinkingDocId, setUnlinkingDocId] = useState<string | null>(null);

  // Selecting another asset keeps the drawer mounted — snap back to the
  // Overview tab exactly like the previous inline implementation did.
  useEffect(() => {
    setDrawerTab("overview");
  }, [token, shipId, asset.id]);

  // Open a linked manual PDF in a new tab. We fetch the blob (auth-protected
  // endpoint), wrap it in an object URL, then open. URL.revokeObjectURL is
  // delayed because the browser needs the blob alive long enough to render.
  const handleOpenDocument = useCallback(
    async (documentId: string, originalFileName: string) => {
      if (!token) return;
      try {
        const blob = await fetchDocumentFile(token, documentId);
        // Force the PDF type: a generic blob type makes the new tab show a
        // download prompt instead of rendering in the browser PDF viewer.
        const typed = originalFileName.toLowerCase().endsWith(".pdf")
          ? new Blob([blob], { type: "application/pdf" })
          : blob;
        const url = URL.createObjectURL(typed);
        // No "noopener" feature string here: with it, window.open returns
        // null even when the tab DID open, which made the popup-blocked
        // fallback fire too — tab + download dialog at the same time. A
        // blob: URL has no cross-origin opener risk.
        const win = window.open(url, "_blank");
        if (!win) {
          // Popup blocked — fall back to a download link.
          const a = document.createElement("a");
          a.href = url;
          a.download = originalFileName;
          a.click();
        }
        // Revoke after 30s to be safe — long enough for the new tab to load.
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } catch (e) {
        onError(e instanceof Error ? e.message : "Failed to open document");
      }
    },
    [token, onError],
  );

  const handleUnbindMetric = useCallback(
    async (metricId: string) => {
      if (!token) return;
      setUnbindingId(metricId);
      try {
        await updateMetricBinding(token, metricId, null);
        await onRefreshRelated();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Unbind failed");
      } finally {
        setUnbindingId(null);
      }
    },
    [token, onRefreshRelated, onError],
  );

  // Unpin an explicitly-linked manual. Auto-matched docs can't be unlinked
  // (they reappear next refresh anyway) — UI hides the × on those rows.
  const handleUnlinkManual = useCallback(
    async (documentId: string) => {
      if (!token) return;
      setUnlinkingDocId(documentId);
      try {
        await unlinkAssetDocument(token, shipId, asset.id, documentId);
        await onRefreshRelated();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Unlink failed");
      } finally {
        setUnlinkingDocId(null);
      }
    },
    [token, shipId, asset.id, onRefreshRelated, onError],
  );

  const handleUpdateMetricUnit = useCallback(
    async (metricId: string, nextUnit: string | null) => {
      if (!token) return;
      try {
        await updateMetricUnit(token, metricId, nextUnit);
        await onRefreshRelated();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Unit update failed");
        throw e;
      }
    },
    [token, onRefreshRelated, onError],
  );

  const save = (field: keyof UpdateAssetInput) =>
    makeFieldSaver(asset.id, field);

  return (
    <aside className="assets-section__drawer">
      <div className="assets-section__drawer-head">
        <div>
          <div className="assets-section__drawer-topline">
            <span className="assets-section__drawer-code">
              {asset.assetIdInternal}
            </span>
            <span
              className={`assets-section__drawer-status assets-section__drawer-status--${
                asset.lifecycleStatus === "in-service" ? "ok" : "off"
              }`}
            >
              ●{" "}
              {asset.lifecycleStatus === "in-service"
                ? "OPERATIONAL"
                : (asset.lifecycleStatus ?? "—").toUpperCase()}
            </span>
          </div>
          <div className="assets-section__drawer-name">{asset.displayName}</div>
          <div className="assets-section__drawer-meta">
            {[
              asset.brand,
              asset.model,
              asset.serialNo ? `S/N ${asset.serialNo}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "—"}
          </div>
          {asset.location && (
            <div className="assets-section__drawer-meta">{asset.location}</div>
          )}
        </div>
        <button
          type="button"
          className="assets-section__drawer-close"
          onClick={onClose}
          aria-label="Close detail"
        >
          ×
        </button>
      </div>

      <div className="assets-section__drawer-tabs" role="tablist">
        {(
          [
            ["overview", "Overview", null],
            ["metrics", "Metrics", related?.metrics.length ?? null],
            ["manuals", "Manuals", related?.documents.length ?? null],
            ["pms", "PMS", serviceRules?.length ?? null],
            ["certs", "Certs", assetCerts?.length ?? null],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={drawerTab === key}
            className={`assets-section__drawer-tab${
              drawerTab === key ? " assets-section__drawer-tab--active" : ""
            }`}
            onClick={() => setDrawerTab(key)}
          >
            {label}
            {count !== null && count > 0 && (
              <span className="assets-section__drawer-tab-count">{count}</span>
            )}
          </button>
        ))}
      </div>

      {/*
        Full-details panel — every editable column the table doesn't
        show, plus read-only provenance + extras. Double-click any
        cell to edit (Enter to save, Escape to cancel). Frees the
        main table from carrying every column while still letting
        admins fix all the data without leaving the page.
      */}
      {drawerTab === "overview" && (
      <div className="assets-section__drawer-section">
        <div className="assets-section__drawer-fields">
          <OverviewFieldRow label="SFI group" value={asset.sfiGroup} onSave={save("sfiGroup")} />
          <OverviewFieldRow label="SFI sub" value={asset.sfiSub} onSave={save("sfiSub")} />
          <OverviewFieldRow label="Sub name" value={asset.sfiSubName} onSave={save("sfiSubName")} width="full" />
          <OverviewFieldRow label="Brand" value={asset.brand} onSave={save("brand")} />
          <OverviewFieldRow label="Model" value={asset.model} onSave={save("model")} />
          <OverviewFieldRow label="Serial №" value={asset.serialNo} onSave={save("serialNo")} />
          <OverviewFieldRow label="Criticality (1-5)" value={asset.criticality?.toString() ?? null} onSave={save("criticality")} />
          <OverviewFieldRow label="Lifecycle" value={asset.lifecycleStatus} onSave={save("lifecycleStatus")} />
          <OverviewFieldRow label="Commissioned" value={asset.commissionedDate} onSave={save("commissionedDate")} placeholder="YYYY-MM-DD" />
          <OverviewFieldRow label="Location (text)" value={asset.location} onSave={save("location")} width="full" />
          <OverviewFieldRow label="Parent asset" value={asset.parentAssetId} placeholder="—" />
          <OverviewFieldRow label="Served by" value={asset.servedByAssetId} placeholder="—" />
          <OverviewFieldRow label="Located in" value={asset.locationAssetId} placeholder="—" />
          <OverviewFieldRow label="RINA ref" value={asset.rinaRef} placeholder="—" />
          <OverviewFieldRow label="Zone" value={asset.zone} onSave={save("zone")} placeholder="H/T/M/…" />
          <OverviewFieldRow label="Deck role" value={asset.deckRole} onSave={save("deckRole")} placeholder="BRG/SUN/TT/…" />
          <OverviewFieldRow label="Deck level" value={asset.deckLevel?.toString() ?? null} placeholder="int" />
          <OverviewFieldRow label="Space" value={asset.spaceInstance} onSave={save("spaceInstance")} placeholder="GC-04-PS" />
          <OverviewFieldRow label="Space label" value={asset.spaceLabel} onSave={save("spaceLabel")} width="full" />
          <OverviewFieldRow label="Drawing ref" value={asset.drawingRef} onSave={save("drawingRef")} width="full" />
          <OverviewFieldRow label="Inspection" value={asset.inspectionObligation} onSave={save("inspectionObligation")} width="full" />
          <OverviewFieldRow label="Notes" value={asset.notes} onSave={save("notes")} width="full" />
          {asset.sourceSheet && (
            <OverviewFieldRow label="Source sheet" value={asset.sourceSheet} width="full" />
          )}
          {asset.extras && Object.keys(asset.extras).length > 0 && (
            <div className="assets-section__field assets-section__field--full">
              <span className="assets-section__field-label">Extras</span>
              <span className="assets-section__field-readonly assets-section__field-extras">
                {Object.entries(asset.extras)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join("  ·  ")}
              </span>
            </div>
          )}
        </div>
      </div>

      )}

      {drawerTab === "metrics" && (
      <div className="assets-section__drawer-section">
        <div className="assets-section__drawer-section-head">
          Bound metrics
          <button
            type="button"
            className="assets-section__drawer-section-btn"
            onClick={() => setPickerOpen((v) => !v)}
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
            currentAssetId={asset.id}
            alreadyBoundIds={new Set((related?.metrics ?? []).map((m) => m.id))}
            onClose={() => setPickerOpen(false)}
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
                    onSave={(next) => handleUpdateMetricUnit(m.id, next)}
                  />
                </span>
                <button
                  type="button"
                  className="assets-section__metric-unbind"
                  onClick={() => void handleUnbindMetric(m.id)}
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

      )}

      {drawerTab === "manuals" && (
      <div className="assets-section__drawer-section">
        <div className="assets-section__drawer-section-head">
          Linked manuals
          <button
            type="button"
            className="assets-section__drawer-section-btn"
            onClick={() => setManualPickerOpen((v) => !v)}
          >
            {manualPickerOpen ? "× Cancel" : "+ Link"}
          </button>
        </div>
        <div className="assets-section__drawer-section-note">
          Explicit pins + brand/model auto-matches. × on a pinned doc
          removes the link; × on an auto-match hides it permanently
          (re-link via + Link to undo).
        </div>
        {manualPickerOpen && (
          <LinkManualPicker
            token={token}
            shipId={shipId}
            currentAssetId={asset.id}
            alreadyLinkedIds={new Set(related?.documents.map((d) => d.id) ?? [])}
            onClose={() => setManualPickerOpen(false)}
            onLinked={() => {
              void onRefreshRelated();
              setManualPickerOpen(false);
            }}
          />
        )}
        {!relatedLoading && related && related.documents.length === 0 && (
          <div className="assets-section__placeholder">
            No documents linked or matched. Click + Link to pin one.
          </div>
        )}
        {!relatedLoading &&
          related &&
          related.documents.map((d) => (
            <div
              key={d.id}
              className="assets-section__doc-row assets-section__doc-row--clickable"
            >
              <button
                type="button"
                className="assets-section__doc-row-main"
                onClick={() => void handleOpenDocument(d.id, d.originalFileName)}
                title="Click to open"
              >
                <span className="assets-section__doc-name">
                  📄 {d.originalFileName}
                  {d.linkSource === "explicit" && (
                    <span
                      className="assets-section__doc-badge"
                      title="Explicitly linked by admin"
                    >
                      pinned
                    </span>
                  )}
                </span>
                <span className="assets-section__doc-meta">
                  {d.manufacturer ?? "—"} · {d.parseStatus}
                </span>
              </button>
              <button
                type="button"
                className="assets-section__metric-unbind"
                onClick={() => void handleUnlinkManual(d.id)}
                disabled={unlinkingDocId === d.id}
                aria-label={`Unlink ${d.originalFileName}`}
                title={
                  d.linkSource === "explicit"
                    ? "Unlink this manual"
                    : "Hide this auto-match for this asset"
                }
              >
                {unlinkingDocId === d.id ? "…" : "×"}
              </button>
            </div>
          ))}
      </div>
      )}

      {drawerTab === "certs" && (
      <div className="assets-section__drawer-section">
        {assetCerts === null && (
          <div className="assets-section__placeholder">Loading…</div>
        )}
        {assetCerts !== null && assetCerts.length === 0 && (
          <div className="assets-section__placeholder">
            No compliance documents linked to this asset yet. Link
            records to assets in the Compliance Docs section.
          </div>
        )}
        {assetCerts?.map((rec) => (
          <div key={rec.id} className="compliance__record">
            <StatusBadge base="compliance__badge" variant={rec.status}>
              {rec.status.toUpperCase()}
            </StatusBadge>
            <span className="compliance__record-main">
              {rec.sfiCode} {rec.typeName ?? "—"}
              {rec.certNo ? ` · ${rec.certNo}` : ""}
            </span>
            <span className="compliance__record-dates">
              {rec.issueDate ?? "?"} → {rec.expiryDate ?? "—"}
            </span>
          </div>
        ))}
      </div>
      )}

      {drawerTab === "pms" && (
      <div className="assets-section__drawer-section">
        {serviceRules === null && (
          <div className="assets-section__placeholder">Loading…</div>
        )}
        {serviceRules !== null && serviceRules.length === 0 && (
          <div className="assets-section__placeholder">
            No service rules for this asset yet. Rules are extracted
            from manuals by the AI or added via the PMS API.
          </div>
        )}
        {serviceRules?.map((rule) => {
          const v = ruleVerdict(rule);
          return (
            <div key={rule.id} className="assets-section__pms-row">
              <div className="assets-section__pms-main">
                <span className="assets-section__pms-name">
                  🔧 {rule.taskName}
                </span>
                <span className="assets-section__pms-due">
                  {v.due
                    ? `Due ${v.due}`
                    : [
                        rule.intervalHours != null
                          ? `every ${rule.intervalHours} h`
                          : null,
                        rule.intervalMonths != null
                          ? `every ${rule.intervalMonths} mo`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(" / ") || "no interval"}
                  {!rule.lastDoneAt && " · no last-done baseline"}
                </span>
              </div>
              <StatusBadge base="assets-section__pms-badge" variant={v.level}>
                {v.label}
              </StatusBadge>
            </div>
          );
        })}
      </div>
      )}
    </aside>
  );
}
