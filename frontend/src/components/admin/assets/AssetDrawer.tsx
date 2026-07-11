import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  listAssetAlerts,
  severityColor,
  type Alert,
} from "../../../api/alertsApi";
import {
  unlinkAssetDocument,
  updateMetricBinding,
  updateMetricUnit,
  type AssetItem,
  type RelatedAssetResult,
  type UpdateAssetInput,
} from "../../../api/assetsApi";
import {
  openComplianceDocFile,
  type AssetComplianceRecord,
} from "../../../api/complianceApi";
import { formatDateDMY } from "../compliance/complianceLabels";
import { fetchSfiGroups, fetchSfiSubs, type SfiNode } from "../../../api/sfiApi";
import {
  fetchDocumentFile,
  fetchExtractedMarkdown,
} from "../../../api/documentsApi";
import {
  suggestPmsFromManual,
  commitPmsImport,
  type PmsImportPreview,
  type PmsImportDraft,
} from "../../../api/pmsApi";
import { ImportPreviewModal } from "../PmsSection";
import {
  listAssetInventory,
  suggestInventoryFromManual,
  commitInventory,
  type InventoryItem,
  type InventoryDraft,
} from "../../../api/inventoryApi";
import { InventorySuggestModal } from "./InventorySuggestModal";
import type { PmsTaskDto } from "../../../api/pmsApi";
import { AssetHoursPanel } from "./AssetHoursPanel";
import { StatusBadge } from "../StatusBadge";
import { BindMetricPicker } from "./BindMetricPicker";
import { EditableCell } from "./EditableCell";
import { LinkManualPicker } from "./LinkManualPicker";

type DrawerTab = "overview" | "metrics" | "manuals" | "pms" | "certs" | "parts" | "alerts";

/**
 * Client-side PMS verdict on the calendar axis only (the hours axis
 * needs a live runtime counter — backend find_pms_due owns that logic).
 * OVERDUE: months interval elapsed since last-done. UPCOMING: due within
 * 30 days. OK: due later. UNKNOWN: no last-done baseline or no
 * calendar interval.
 */

/**
 * One labelled row in the overview "full details" grid. Declared at MODULE
 * level on purpose: defining it inside the render function recreates its
 * type every render, React unmounts/remounts the EditableCell input, and
 * focus is lost mid-edit (the known "can't type more than one character"
 * bug in this codebase).
 */
/**
 * SFI group / sub-group selectors driven by the taxonomy catalog. Picking a
 * group saves code+name and clears the sub pair; picking a sub saves its
 * code+name. The names themselves are never hand-edited.
 */
function SfiCascadeRows({
  token,
  asset,
  onPatch,
}: {
  token: string | null;
  asset: AssetItem;
  onPatch: (assetId: string, patch: UpdateAssetInput) => Promise<void>;
}) {
  const [groups, setGroups] = useState<SfiNode[]>([]);
  const [subs, setSubs] = useState<SfiNode[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    void fetchSfiGroups(token)
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [token]);

  useEffect(() => {
    if (!token || !asset.sfiGroup) {
      setSubs([]);
      return;
    }
    void fetchSfiSubs(token, asset.sfiGroup)
      .then(setSubs)
      .catch(() => setSubs([]));
  }, [token, asset.sfiGroup]);

  const pickGroup = async (code: string) => {
    const group = groups.find((g) => g.code === code);
    setBusy(true);
    try {
      await onPatch(asset.id, {
        sfiGroup: code || null,
        sfiGroupName: group?.name ?? null,
        // group change invalidates the previous sub pair
        sfiSub: null,
        sfiSubName: null,
      });
    } finally {
      setBusy(false);
    }
  };

  const pickSub = async (code: string) => {
    const sub = subs.find((s) => s.code === code);
    setBusy(true);
    try {
      await onPatch(asset.id, {
        sfiSub: code || null,
        sfiSubName: sub?.name ?? null,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="assets-section__field assets-section__field--half">
        <span className="assets-section__field-label">SFI group</span>
        <select
          className="assets-section__field-select"
          value={asset.sfiGroup ?? ""}
          disabled={busy}
          onChange={(e) => void pickGroup(e.target.value)}
        >
          <option value="">—</option>
          {groups.map((g) => (
            <option key={g.code} value={g.code}>
              {g.code} — {g.name}
            </option>
          ))}
        </select>
      </div>
      <div className="assets-section__field assets-section__field--half">
        <span className="assets-section__field-label">SFI sub</span>
        <select
          className="assets-section__field-select"
          value={asset.sfiSub ?? ""}
          disabled={busy || !asset.sfiGroup}
          onChange={(e) => void pickSub(e.target.value)}
        >
          <option value="">{asset.sfiGroup ? "—" : "Select group first"}</option>
          {subs.map((s) => (
            <option key={s.code} value={s.code}>
              {s.code} — {s.name}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

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
  serviceRules: PmsTaskDto[] | null;
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
  /** Multi-field save — the SFI cascade writes code + name together. */
  onPatch: (assetId: string, patch: UpdateAssetInput) => Promise<void>;
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
  onPatch,
}: AssetDrawerProps) {
  const [drawerTab, setDrawerTab] = useState<DrawerTab>("overview");
  const [suggestPreview, setSuggestPreview] = useState<PmsImportPreview | null>(
    null,
  );
  const [suggestBusy, setSuggestBusy] = useState(false);
  // The asset's linked manual (drives both "Suggest PMS" and "Suggest parts").
  const manualDoc = related?.documents.find((d) => d.docClass === "manual");
  // Manuals tab lists knowledge-base docs only — certificates belong to the
  // Certs tab (compliance) and drawings to the Overview block, not here.
  const manualDocs =
    related?.documents.filter(
      (d) => d.docClass !== "certificate" && d.docClass !== "plan",
    ) ?? [];
  const drawings = related?.drawings ?? [];
  const [parts, setParts] = useState<InventoryItem[]>([]);
  const [partsPreview, setPartsPreview] = useState<{
    drafts: InventoryDraft[];
    notes: string[];
  } | null>(null);
  const [partsBusy, setPartsBusy] = useState(false);

  const loadParts = useCallback(async () => {
    if (!token) return;
    try {
      setParts(await listAssetInventory(token, shipId, asset.id));
    } catch {
      setParts([]);
    }
  }, [token, shipId, asset.id]);
  useEffect(() => {
    void loadParts();
  }, [loadParts]);

  const [alerts, setAlerts] = useState<Alert[]>([]);
  useEffect(() => {
    if (!token) return;
    let alive = true;
    void listAssetAlerts(token, shipId, asset.id)
      .then((a) => alive && setAlerts(a))
      .catch(() => alive && setAlerts([]));
    return () => {
      alive = false;
    };
  }, [token, shipId, asset.id]);
  const firingAlerts = useMemo(
    () => alerts.filter((a) => a.status === "firing").length,
    [alerts],
  );

  const handleSuggestParts = useCallback(async () => {
    if (!token || !manualDoc) return;
    setPartsBusy(true);
    try {
      const { markdown } = await fetchExtractedMarkdown(token, manualDoc.id);
      const res = await suggestInventoryFromManual(
        token,
        shipId,
        asset.id,
        markdown,
      );
      setPartsPreview(res);
    } catch (e) {
      onError(
        e instanceof Error ? e.message : "Could not read the manual.",
      );
    } finally {
      setPartsBusy(false);
    }
  }, [token, manualDoc, shipId, asset.id, onError]);

  const handleConfirmParts = useCallback(
    async (drafts: InventoryDraft[]) => {
      if (!token) return;
      setPartsBusy(true);
      try {
        await commitInventory(token, shipId, drafts);
        setPartsPreview(null);
        await loadParts();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Failed to add parts");
      } finally {
        setPartsBusy(false);
      }
    },
    [token, shipId, loadParts, onError],
  );

  const handleSuggestPms = useCallback(async () => {
    if (!token || !manualDoc) return;
    setSuggestBusy(true);
    try {
      const { markdown } = await fetchExtractedMarkdown(token, manualDoc.id);
      const preview = await suggestPmsFromManual(
        token,
        shipId,
        asset.id,
        markdown,
      );
      setSuggestPreview(preview);
    } catch (e) {
      onError(
        e instanceof Error
          ? e.message
          : "Could not read the manual — make sure it's extracted.",
      );
    } finally {
      setSuggestBusy(false);
    }
  }, [token, manualDoc, shipId, asset.id, onError]);

  const handleConfirmSuggest = useCallback(
    async (drafts: PmsImportDraft[]) => {
      if (!token) return;
      setSuggestBusy(true);
      try {
        await commitPmsImport(token, shipId, drafts);
        setSuggestPreview(null);
        await onRefreshRelated();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Failed to create tasks");
      } finally {
        setSuggestBusy(false);
      }
    },
    [token, shipId, onRefreshRelated, onError],
  );
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
            ["parts", "Parts", parts.length || null],
            ["alerts", "Alerts", firingAlerts || null],
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
        {/* Only the columns present in the final register format (14-col). */}
        <div className="assets-section__drawer-fields">
          {/* SFI comes from the taxonomy: pick group → sub; the names are
              static catalog values saved alongside the codes. */}
          <SfiCascadeRows token={token} asset={asset} onPatch={onPatch} />
          <OverviewFieldRow label="Group name" value={asset.sfiGroupName} />
          <OverviewFieldRow label="Sub name" value={asset.sfiSubName} />
          <OverviewFieldRow label="Brand" value={asset.brand} onSave={save("brand")} />
          <OverviewFieldRow label="Model" value={asset.model} onSave={save("model")} />
          <OverviewFieldRow label="Serial №" value={asset.serialNo} onSave={save("serialNo")} />
          <OverviewFieldRow label="Served by" value={asset.servedByAssetId} placeholder="—" />
          <OverviewFieldRow label="Location" value={asset.location} onSave={save("location")} width="full" />
          <OverviewFieldRow label="Drawing ref" value={asset.drawingRef} onSave={save("drawingRef")} />
          <OverviewFieldRow label="Drawing code" value={asset.drawingCode} onSave={save("drawingCode")} />
          <OverviewFieldRow label="Notes" value={asset.notes} onSave={save("notes")} width="full" />
        </div>

        {/* Drawings — file pointers (never parsed): explicit links + register
            drawing-code matches. Click to open the original. */}
        {drawings.length > 0 && (
          <div className="assets-section__drawings">
            <div className="assets-section__drawer-section-head">Drawings</div>
            {drawings.map((d) => (
              <div
                key={d.id}
                className="assets-section__doc-row assets-section__doc-row--clickable"
              >
                <button
                  type="button"
                  className="assets-section__doc-row-main"
                  onClick={() => void handleOpenDocument(d.id, d.originalFileName)}
                  title="Click to open the drawing"
                >
                  <span className="assets-section__doc-name">
                    📐 {d.originalFileName}
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
                    {d.linkSource === "explicit"
                      ? "linked"
                      : `matched by drawing ref ${asset.drawingCode ?? asset.drawingRef ?? ""}`}
                  </span>
                </button>
              </div>
            ))}
          </div>
        )}
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
        {!relatedLoading && related && manualDocs.length === 0 && (
          <div className="assets-section__placeholder">
            No documents linked or matched. Click + Link to pin one.
          </div>
        )}
        {!relatedLoading &&
          related &&
          manualDocs.map((d) => (
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
              {formatDateDMY(rec.issueDate) ?? "?"} →{" "}
              {formatDateDMY(rec.expiryDate) ?? "—"}
            </span>
            {rec.hasFile && (
              <button
                type="button"
                className="compliance__record-open"
                onClick={() => {
                  if (token) void openComplianceDocFile(token, shipId, rec.id);
                }}
                title="Open / preview file"
              >
                Open
              </button>
            )}
          </div>
        ))}
      </div>
      )}

      {drawerTab === "pms" && (
      <div className="assets-section__drawer-section">
        <AssetHoursPanel
          token={token}
          shipId={shipId}
          assetId={asset.id}
          metricOptions={(related?.metrics ?? []).map((m) => ({
            id: m.id,
            label: `${m.measurement}.${m.field}`,
          }))}
        />

        <div className="assets-section__pms-suggest">
          <button
            type="button"
            className="pms__btn"
            disabled={!manualDoc || suggestBusy}
            onClick={() => void handleSuggestPms()}
            title={
              manualDoc
                ? `Propose maintenance tasks from ${manualDoc.originalFileName}`
                : "Link a manual to this asset first (Manuals tab)"
            }
          >
            {suggestBusy
              ? "Reading manual…"
              : manualDoc
                ? "Suggest PMS from manual"
                : "Suggest PMS (no manual linked)"}
          </button>
        </div>

        {suggestPreview &&
          createPortal(
            <ImportPreviewModal
              preview={suggestPreview}
              busy={suggestBusy}
              onCancel={() => setSuggestPreview(null)}
              onConfirm={handleConfirmSuggest}
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
          return (
            <div key={t.id} className="assets-section__pms-row">
              <div className="assets-section__pms-main">
                <span className="assets-section__pms-name">
                  {isReminder ? "🕐" : "🔧"} {t.task}
                </span>
                <span className="assets-section__pms-due">
                  {t.due}
                  {isReminder
                    ? " · monthly reading"
                    : t.intervalHours != null
                      ? ` · every ${t.intervalHours} h`
                      : ""}
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
      )}

      {drawerTab === "parts" && (
      <div className="assets-section__drawer-section">
        <div className="assets-section__pms-suggest">
          <button
            type="button"
            className="pms__btn"
            disabled={!manualDoc || partsBusy}
            onClick={() => void handleSuggestParts()}
            title={
              manualDoc
                ? `Suggest parts from ${manualDoc.originalFileName}`
                : "Link a manual to this asset first (Manuals tab)"
            }
          >
            {partsBusy
              ? "Reading manual…"
              : manualDoc
                ? "Suggest parts from manual"
                : "Suggest parts (no manual linked)"}
          </button>
        </div>

        {parts.length === 0 ? (
          <div className="assets-section__placeholder">
            No parts linked to this asset yet. Use “Suggest parts from manual”,
            or add them in the Inventory section.
          </div>
        ) : (
          <>
          <div className="inv__table-wrap inv__table-wrap--asset">
            <table className="inv__table inv__table--asset">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Number</th>
                  <th>Cat.</th>
                  <th>Qty</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => (
                  <tr key={p.id} className="inv__row">
                    <td className="inv__name">{p.name}</td>
                    <td className="inv__mono">{p.partNumber ?? "—"}</td>
                    <td><span className="inv__cat">{p.category}</span></td>
                    <td>{p.quantity != null ? `${p.quantity}${p.unit ? " " + p.unit : ""}` : "—"}</td>
                    <td className="inv__notes-cell" title={p.notes ?? ""}>{p.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="inv__asset-count">{parts.length} part{parts.length === 1 ? "" : "s"} linked</p>
          </>
        )}

        {partsPreview &&
          <InventorySuggestModal
            drafts={partsPreview.drafts}
            notes={partsPreview.notes}
            busy={partsBusy}
            onCancel={() => setPartsPreview(null)}
            onConfirm={handleConfirmParts}
          />}
      </div>
      )}

      {drawerTab === "alerts" && (
      <div className="assets-section__drawer-section">
        {alerts.length === 0 ? (
          <div className="assets-section__placeholder">
            No alerts for this asset. Metric alerts from Grafana that resolve to
            this asset appear here.
          </div>
        ) : (
          <div className="inv__table-wrap inv__table-wrap--asset">
            <table className="inv__table inv__table--asset">
              <thead>
                <tr>
                  <th>Sev.</th>
                  <th>Alert</th>
                  <th>Value</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className="inv__row">
                    <td>
                      <span style={{ color: severityColor(a.severity) }}>
                        ● {a.severity}
                      </span>
                    </td>
                    <td className="inv__name">
                      {a.title}
                      {a.message && (
                        <div className="alert__msg" title={a.message}>
                          {a.message.split("\n")[0]}
                        </div>
                      )}
                    </td>
                    <td className="inv__mono">{a.value != null ? a.value : "—"}</td>
                    <td>
                      <span className={`alert__status alert__status--${a.status}`}>
                        {a.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      )}
    </aside>
  );
}
