import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listAssetAlerts, type Alert } from "../../../api/alertsApi";
import {
  listAssets,
  unlinkAssetDocument,
  updateMetricBinding,
  updateMetricUnit,
  type AssetItem,
  type RelatedAssetResult,
  type UpdateAssetInput,
} from "../../../api/assetsApi";
import type { AssetOption } from "../AssetMultiSelect";
import { AssetAlertsTab } from "./drawer/AssetAlertsTab";
import { AssetOverviewTab } from "./drawer/AssetOverviewTab";
import { AssetCertsTab } from "./drawer/AssetCertsTab";
import { AssetManualsTab } from "./drawer/AssetManualsTab";
import { AssetMetricsTab } from "./drawer/AssetMetricsTab";
import { AssetPmsTab } from "./drawer/AssetPmsTab";
import { AssetPartsTab } from "./drawer/AssetPartsTab";
import type { AssetComplianceRecord } from "../../../api/complianceApi";
import {
  fetchDocumentFile,
  fetchExtractedMarkdown,
  uploadDocument,
} from "../../../api/documentsApi";
import {
  suggestPmsFromManual,
  commitPmsImport,
  type PmsImportPreview,
  type PmsImportDraft,
} from "../../../api/pmsApi";
import {
  listAssetInventory,
  suggestInventoryFromManual,
  commitInventory,
  type InventoryItem,
  type InventoryDraft,
} from "../../../api/inventoryApi";
import type { PmsTaskDto } from "../../../api/pmsApi";

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
      (d) =>
        d.docClass !== "certificate" &&
        d.docClass !== "plan" &&
        d.docClass !== "type_approval",
    ) ?? [];
  // Manufacturer approvals of the equipment TYPE (MED Module B/D, EC type
  // examination, declarations of conformity). They approve a model rather than
  // this unit, never expire, and belong to the asset — they stay out of
  // the vessel's certificate register entirely.
  const typeApprovals =
    related?.documents.filter((d) => d.docClass === "type_approval") ?? [];
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

  // Register options for the "Served by" picker. served_by_asset_id stores the
  // INTERNAL code (e.g. SWX.2.11.02), so option ids are assetIdInternal.
  const [registerOptions, setRegisterOptions] = useState<AssetOption[]>([]);
  useEffect(() => {
    if (!token) return;
    void listAssets(token, shipId, { limit: 2000 })
      .then((r) =>
        setRegisterOptions(
          r.items.map((a) => ({
            id: a.assetIdInternal,
            label: `${a.assetIdInternal} — ${a.displayName}`,
            sfiGroup: a.sfiGroup,
            sfiGroupName: a.sfiGroupName,
            sfiSub: a.sfiSub,
            sfiSubName: a.sfiSubName,
          })),
        ),
      )
      .catch(() => setRegisterOptions([]));
  }, [token, shipId]);

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
  // Upload a manufacturer type approval straight onto this asset. The
  // documents upload already takes an assetId and pins the link, and the
  // `type_approval` class is a file store — no RAGFlow, no vision extraction.
  const typeApprovalInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadingApproval, setUploadingApproval] = useState(false);
  const handleTypeApprovalPicked = useCallback(
    async (file: File | null) => {
      if (!token || !file) return;
      setUploadingApproval(true);
      try {
        await uploadDocument(token, file, {
          shipId,
          docClass: "type_approval",
          assetId: asset.id,
          // The upload path renames the file to "<brand> <model> — <asset>"
          // when an assetId is given, so the approval is recognisable in the
          // documents list without any extra metadata here.
        });
        await onRefreshRelated();
      } catch (e) {
        onError(e instanceof Error ? e.message : "Failed to upload approval");
      } finally {
        setUploadingApproval(false);
      }
    },
    [token, shipId, asset.id, onRefreshRelated, onError],
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

  /**
   * Catalogue rule: "Add a prompt to verify and
   * replace linked type approval/MED/DoC documents whenever the brand, type or
   * model of an asset changes. Existing documents should only remain linked
   * where they still apply to the updated equipment."
   *
   * A type approval approves a MODEL. Change the model and the approval on file
   * may now describe equipment that is no longer fitted — the link has to be
   * reviewed by a human, so this asks rather than guessing.
   */
  const [approvalReview, setApprovalReview] = useState<{
    field: string;
    from: string | null;
    to: string | null;
  } | null>(null);

  const saveIdentity = (field: "brand" | "model") => {
    const saver = makeFieldSaver(asset.id, field);
    return async (next: string | null) => {
      const before = asset[field] ?? null;
      await saver(next);
      const changed = (before ?? "") !== (next ?? "");
      if (changed && typeApprovals.length > 0) {
        setApprovalReview({ field, from: before, to: next ?? null });
      }
    };
  };

  return (
    <aside className="assets-section__drawer">
      <div className="assets-section__drawer-head">
        <div>
          <div className="assets-section__drawer-topline">
            <span className="assets-section__drawer-code">
              {asset.assetIdInternal}
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
          {approvalReview && (
            <div className="assets-section__approval-review">
              <span>
                {approvalReview.field === "brand" ? "Brand" : "Model"} changed
                {approvalReview.from ? ` from "${approvalReview.from}"` : ""} to{" "}
                "{approvalReview.to ?? "—"}". This asset has{" "}
                {typeApprovals.length}{" "}
                {typeApprovals.length === 1 ? "type approval" : "type approvals"}{" "}
                linked — check they still apply to the new equipment.
              </span>
              <button
                type="button"
                className="compliance__record-open"
                onClick={() => {
                  setDrawerTab("certs");
                  setApprovalReview(null);
                }}
              >
                Review
              </button>
              <button
                type="button"
                className="compliance__record-open"
                onClick={() => setApprovalReview(null)}
                title="They still apply — keep the links"
              >
                Still apply
              </button>
            </div>
          )}
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
            // Counts must match what each tab actually lists: type approvals
            // moved to Certs, so counting them under Manuals showed a badge
            // for documents that tab does not render.
            ["manuals", "Manuals", related ? manualDocs.length : null],
            ["pms", "PMS", serviceRules?.length ?? null],
            [
              "certs",
              "Certs",
              assetCerts === null && related === null
                ? null
                : (assetCerts?.length ?? 0) + typeApprovals.length,
            ],
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
        <AssetOverviewTab
          token={token}
          asset={asset}
          drawings={drawings}
          registerOptions={registerOptions}
          onPatch={onPatch}
          save={save}
          saveIdentity={saveIdentity}
          unlinkingDocId={unlinkingDocId}
          onUnlink={(id) => void handleUnlinkManual(id)}
          onOpenDocument={(id, name) => void handleOpenDocument(id, name)}
        />
      )}

      {drawerTab === "metrics" && (
        <AssetMetricsTab
          token={token}
          shipId={shipId}
          assetId={asset.id}
          related={related}
          relatedLoading={relatedLoading}
          pickerOpen={pickerOpen}
          onTogglePicker={() => setPickerOpen((v) => !v)}
          onClosePicker={() => setPickerOpen(false)}
          onRefreshRelated={onRefreshRelated}
          unbindingId={unbindingId}
          onUnbind={(id) => void handleUnbindMetric(id)}
          onUpdateUnit={handleUpdateMetricUnit}
        />
      )}

      {drawerTab === "manuals" && (
        <AssetManualsTab
          token={token}
          shipId={shipId}
          assetId={asset.id}
          related={related}
          relatedLoading={relatedLoading}
          manualDocs={manualDocs}
          pickerOpen={manualPickerOpen}
          onTogglePicker={() => setManualPickerOpen((v) => !v)}
          onClosePicker={() => setManualPickerOpen(false)}
          onRefreshRelated={onRefreshRelated}
          unlinkingDocId={unlinkingDocId}
          onUnlink={(id) => void handleUnlinkManual(id)}
          onOpenDocument={(id, name) => void handleOpenDocument(id, name)}
        />
      )}

      {drawerTab === "certs" && (
        <AssetCertsTab
          token={token}
          shipId={shipId}
          typeApprovals={typeApprovals}
          assetCerts={assetCerts}
          uploadInputRef={typeApprovalInputRef}
          uploading={uploadingApproval}
          onUploadPicked={(file) => void handleTypeApprovalPicked(file)}
        />
      )}

      {drawerTab === "pms" && (
        <AssetPmsTab
          token={token}
          shipId={shipId}
          assetId={asset.id}
          related={related}
          serviceRules={serviceRules}
          manualFileName={manualDoc?.originalFileName ?? null}
          busy={suggestBusy}
          preview={suggestPreview}
          onSuggest={() => void handleSuggestPms()}
          onCancelPreview={() => setSuggestPreview(null)}
          onConfirmPreview={handleConfirmSuggest}
        />
      )}

      {drawerTab === "parts" && (
        <AssetPartsTab
          parts={parts}
          manualFileName={manualDoc?.originalFileName ?? null}
          busy={partsBusy}
          preview={partsPreview}
          onSuggest={() => void handleSuggestParts()}
          onCancelPreview={() => setPartsPreview(null)}
          onConfirmPreview={handleConfirmParts}
        />
      )}

      {drawerTab === "alerts" && <AssetAlertsTab alerts={alerts} />}
    </aside>
  );
}