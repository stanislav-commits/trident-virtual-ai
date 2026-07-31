import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAdminShip } from "../../context/AdminShipContext";
import {
  getRelatedAsset,
  previewImportAssetsXlsx,
  updateAsset,
  deleteAsset,
  clearAllAssets,
  exportAssetsXlsx,
  type AssetItem,
  type ImportPreviewResult,
  type RelatedAssetResult,
  type UpdateAssetInput,
} from "../../api/assetsApi";
import { listAssetPmsTasks, type PmsTaskDto } from "../../api/pmsApi";
import {
  fetchAssetComplianceDocs,
  type AssetComplianceRecord,
} from "../../api/complianceApi";
import { fetchSfiTaxonomy } from "../../api/sfiApi";
import { useAssetsAdminData } from "../../hooks/admin/useAssetsAdminData";
import {
  GROUP_ALL,
  useAssetRegisterView,
} from "../../hooks/admin/useAssetRegisterView";
import { useAdminEvents } from "../../hooks/admin/adminEvents";
import { BulkEditBar } from "./assets/BulkEditBar";
import { AssetDrawer } from "./assets/AssetDrawer";
import { ImportPreviewModal } from "./assets/ImportPreviewModal";
import { AssetGroupTabs } from "./assets/AssetGroupTabs";
import { AssetSubgroupSidebar } from "./assets/AssetSubgroupSidebar";
import { AssetTable } from "./assets/AssetTable";
import { AssetFormModal } from "./assets/AssetFormModal";
import { ConfirmDialog } from "./assets/ConfirmDialog";
import { sfiGroupName } from "./assets/sfi-colors";

interface AssetsSectionProps {
  token: string | null;
}

/**
 * Asset Register — final layout per reference:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Header (title + Import/Reload)                                │
 *   ├──────────────────────────────────────────────────────────────┤
 *   │ Horizontal scrollable group tabs (each tab has colored top    │
 *   │ stripe + group# + name + asset count + NOMINAL/FAULT badge)   │
 *   ├────────────────────┬─────────────────────────────────────────┤
 *   │  LEFT SIDEBAR       │  MAIN AREA                              │
 *   │  ╴ search input     │  ┌─ stats header ─────────────────┐    │
 *   │  ╴ FOCUSED HIERARCHY│  │ 02 Machinery · 40 assets       │    │
 *   │    sub-group tree   │  └────────────────────────────────┘    │
 *   │  ╴ LOADED ASSETS    │                                        │
 *   │    flat list        │  ┌─ table (SFI/Name/Mfr/Status…) ─┐    │
 *   │                     │  └────────────────────────────────┘    │
 *   └────────────────────┴─────────────────────────────────────────┘
 *
 * Click an asset row → right drawer slides in with bound metrics +
 * linked documents (from /assets/:id/related).
 */
export function AssetsSection({ token }: AssetsSectionProps) {
  const { selectedShipId, availableShips } = useAdminShip();
  const effectiveShipId =
    selectedShipId ?? availableShips[0]?.id ?? null;

  const {
    assets,
    loading,
    error,
    reload,
    setError,
    patchAssetLocal,
    removeAssetLocal,
    restoreAssets,
  } = useAssetsAdminData(
    token,
    effectiveShipId,
    true,
  );

  // Live-sync: another admin's asset change on this ship → re-fetch.
  useAdminEvents("assets", (event) => {
    if (event.shipId === effectiveShipId) void reload();
  });

  // Catalog names for group tabs + sub-group labels (Phase 3b). Falls back to
  // the asset's own sfi_sub_name / the hardcoded group map for codes not in
  // the catalog.
  const [sfiNames, setSfiNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!token) return;
    let alive = true;
    fetchSfiTaxonomy(token)
      .then((nodes) => {
        if (alive) setSfiNames(new Map(nodes.map((n) => [n.code, n.name])));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [token]);


  const {
    search,
    setSearch,
    searchActive,
    searchMatches,
    selectedGroup,
    setSelectedGroup,
    selectedSub,
    setSelectedSub,
    selectedAssetId,
    setSelectedAssetId,
    coverageFilter,
    setCoverageFilter,
    groups,
    assetsInGroup,
    subgroups,
    sortedAssets,
    sort,
    toggleSort,
    selectedIds,
    setSelectedIds,
    selectedAssets,
    allVisibleSelected,
    toggleRow,
    toggleAllVisible,
  } = useAssetRegisterView(assets, sfiNames);

  const searchInputRef = useRef<HTMLInputElement>(null);
  // Cmd/Ctrl+K focuses the sidebar search from anywhere in the section.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    inserted: number;
    updated: number;
    skipped: number;
    errors: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── CRUD actions (add / delete one / clear all) ──
  const [showAddModal, setShowAddModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // ── Asset detail (right drawer) — data lives here, UI in <AssetDrawer> ──
  const [related, setRelated] = useState<RelatedAssetResult | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [serviceRules, setServiceRules] = useState<PmsTaskDto[] | null>(
    null,
  );
  const [assetCerts, setAssetCerts] = useState<AssetComplianceRecord[] | null>(
    null,
  );

  const refreshRelated = useCallback(async () => {
    if (!token || !effectiveShipId || !selectedAssetId) return;
    setRelatedLoading(true);
    try {
      const r = await getRelatedAsset(token, effectiveShipId, selectedAssetId);
      setRelated(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load asset detail");
    } finally {
      setRelatedLoading(false);
    }
  }, [token, effectiveShipId, selectedAssetId, setError]);

  useEffect(() => {
    if (!token || !effectiveShipId || !selectedAssetId) {
      setRelated(null);
      setServiceRules(null);
      setAssetCerts(null);
      return;
    }
    void refreshRelated();
    void listAssetPmsTasks(token, effectiveShipId, selectedAssetId)
      .then(setServiceRules)
      .catch(() => setServiceRules([]));
    void fetchAssetComplianceDocs(token, effectiveShipId, selectedAssetId)
      .then(setAssetCerts)
      .catch(() => setAssetCerts([]));
  }, [token, effectiveShipId, selectedAssetId, refreshRelated]);

  // Inline-edit save handler for a single field on a single asset. Returns
  // a closure so each cell only re-renders when ITS asset changes.
  const [savingAssetId, setSavingAssetId] = useState<string | null>(null);
  // Multi-field variant — the drawer's SFI cascade saves code+name together.
  const patchAsset = useCallback(
    async (assetId: string, patch: UpdateAssetInput) => {
      if (!token || !effectiveShipId) return;
      setSavingAssetId(assetId);
      // Optimistic: the edited cell shows the new value instantly (the patch
      // field names line up with the asset row); the update call runs in the
      // background and a silent reload reconciles any server-derived fields.
      const prev = patchAssetLocal(assetId, patch as Partial<AssetItem>);
      try {
        await updateAsset(token, effectiveShipId, assetId, patch);
        void reload();
      } catch (e) {
        restoreAssets(prev);
        setError(e instanceof Error ? e.message : "Update failed");
        throw e;
      } finally {
        setSavingAssetId(null);
      }
    },
    [token, effectiveShipId, reload, setError, patchAssetLocal, restoreAssets],
  );
  const makeFieldSaver = useCallback(
    (assetId: string, field: keyof UpdateAssetInput) =>
      (next: string | null) =>
        patchAsset(assetId, { [field]: next }),
    [patchAsset],
  );

  // ── Import flow (preview → confirm → commit) ──
  // The drop-file action now ONLY runs the preview endpoint; the actual
  // upsert happens via the modal once admin reviews diffs + checks flags.
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<ImportPreviewResult | null>(
    null,
  );
  const handleImport = useCallback(
    async (file: File) => {
      if (!token || !effectiveShipId) return;
      setImporting(true);
      setImportResult(null);
      try {
        const preview = await previewImportAssetsXlsx(
          token,
          effectiveShipId,
          file,
        );
        setPreviewFile(file);
        setPreviewData(preview);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Preview failed");
      } finally {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [token, effectiveShipId, setError],
  );

  const handleDeleteAsset = useCallback(async () => {
    if (!token || !effectiveShipId || !selectedAssetId) return;
    setActionBusy(true);
    setActionError(null);
    // Optimistic: drop the asset and close the drawer instantly; reconcile in
    // the background, restore on failure.
    const deletingId = selectedAssetId;
    const prev = removeAssetLocal(deletingId);
    setConfirmDelete(false);
    setSelectedAssetId(null);
    try {
      await deleteAsset(token, effectiveShipId, deletingId);
      setActionNotice("Asset deleted.");
      void reload();
    } catch (e) {
      restoreAssets(prev);
      setActionError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setActionBusy(false);
    }
  }, [
    token,
    effectiveShipId,
    selectedAssetId,
    reload,
    removeAssetLocal,
    restoreAssets,
    setSelectedAssetId,
  ]);

  const handleClearAll = useCallback(async () => {
    if (!token || !effectiveShipId) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const res = await clearAllAssets(token, effectiveShipId);
      setConfirmClear(false);
      setSelectedAssetId(null);
      setActionNotice(
        `Cleared ${res.deleted} asset${res.deleted === 1 ? "" : "s"}.` +
          (res.snapshotId ? " A rollback snapshot was saved." : ""),
      );
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Clear all failed");
    } finally {
      setActionBusy(false);
    }
  }, [token, effectiveShipId, reload, setSelectedAssetId]);

  const handleExport = useCallback(async () => {
    if (!token || !effectiveShipId) return;
    setExporting(true);
    setError("");
    try {
      const { blob, filename } = await exportAssetsXlsx(token, effectiveShipId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }, [token, effectiveShipId, setError]);

  // ── Stats for current group ──
  const stats = useMemo(
    () => ({
      // Count reflects the focused sub-group when one is selected.
      total: selectedSub
        ? assetsInGroup.filter((a) => (a.sfiSub ?? "—") === selectedSub).length
        : assetsInGroup.length,
    }),
    [assetsInGroup, selectedSub],
  );

  if (!effectiveShipId) {
    return (
      <div className="assets-section__empty">
        Select a ship from the admin header to view its assets.
      </div>
    );
  }

  const selectedAsset: AssetItem | null =
    sortedAssets.find((a) => a.id === selectedAssetId) ??
    assets.find((a) => a.id === selectedAssetId) ??
    null;

  const currentGroupLabel =
    selectedGroup === GROUP_ALL
      ? "All systems"
      : `${selectedGroup} · ${sfiNames.get(selectedGroup) ?? sfiGroupName(selectedGroup)}`;

  // When a sub-group is focused, show its code + name under the group title.
  const currentSubLabel = (() => {
    if (!selectedSub) return null;
    const meta = subgroups.find((s) => s.code === selectedSub);
    if (!meta) return null;
    return `${meta.code} · ${meta.name}`;
  })();

  return (
    <div className="assets-section">
      <div className="assets-section__header">
        <div className="assets-section__header-left">
          <h2 className="assets-section__title">Asset Register</h2>
          <p className="assets-section__subtitle">
            Vessel systems map · SFI-coded equipment hierarchy.{" "}
            {assets.length} assets total.
          </p>
        </div>

        <div className="assets-section__actions">
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImport(f);
            }}
          />
          <button
            type="button"
            className="assets-section__btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing || loading}
          >
            {importing ? "Importing…" : "Import xlsx"}
          </button>
          <button
            type="button"
            className="assets-section__btn"
            onClick={() => void handleExport()}
            disabled={exporting || loading || assets.length === 0}
            title="Download the full register as an xlsx file"
          >
            {exporting ? "Exporting…" : "Export xlsx"}
          </button>
          <button
            type="button"
            className="assets-section__btn"
            onClick={() => {
              setActionError(null);
              setShowAddModal(true);
            }}
            disabled={loading}
          >
            Add asset
          </button>
          <button
            type="button"
            className="assets-section__btn assets-section__btn--danger"
            onClick={() => {
              setActionError(null);
              setConfirmDelete(true);
            }}
            disabled={loading || !selectedAssetId}
            title={
              selectedAssetId
                ? "Delete the selected asset"
                : "Select a row first"
            }
          >
            Delete asset
          </button>
          <button
            type="button"
            className="assets-section__btn assets-section__btn--danger"
            onClick={() => {
              setActionError(null);
              setConfirmClear(true);
            }}
            disabled={loading || assets.length === 0}
          >
            Clear all
          </button>
        </div>
      </div>

      {previewFile && previewData && token && effectiveShipId && (
        <ImportPreviewModal
          token={token}
          shipId={effectiveShipId}
          file={previewFile}
          preview={previewData}
          onClose={() => {
            setPreviewFile(null);
            setPreviewData(null);
          }}
          onApplied={(result) => {
            setImportResult({
              inserted: result.inserted,
              updated: result.updated,
              skipped: result.skipped,
              errors: result.errors.length,
            });
            setPreviewFile(null);
            setPreviewData(null);
            void reload();
          }}
        />
      )}

      {showAddModal && token && effectiveShipId && (
        <AssetFormModal
          token={token}
          shipId={effectiveShipId}
          onClose={() => setShowAddModal(false)}
          onCreated={(code) => {
            setShowAddModal(false);
            setActionNotice(`Asset ${code} created.`);
            void reload();
          }}
        />
      )}

      {confirmDelete && selectedAsset && (
        <ConfirmDialog
          title="Delete asset"
          message={
            <>
              Delete <strong>{selectedAsset.assetIdInternal}</strong> —{" "}
              {selectedAsset.displayName}? Bound metrics will be unbound and
              linked documents detached.
            </>
          }
          confirmLabel="Delete asset"
          danger
          busy={actionBusy}
          error={actionError}
          onCancel={() => {
            setConfirmDelete(false);
            setActionError(null);
          }}
          onConfirm={() => void handleDeleteAsset()}
        />
      )}

      {confirmClear && (
        <ConfirmDialog
          title="Clear all assets"
          message={
            <>
              This permanently deletes <strong>all {assets.length} assets</strong>{" "}
              on this vessel and unbinds every metric. A rollback snapshot is
              saved first, but it cannot be undone from the UI.
            </>
          }
          confirmLabel="Clear all"
          danger
          requireText="CLEAR"
          busy={actionBusy}
          error={actionError}
          onCancel={() => {
            setConfirmClear(false);
            setActionError(null);
          }}
          onConfirm={() => void handleClearAll()}
        />
      )}

      {importResult && (
        <div className="assets-section__banner assets-section__banner--ok">
          Import complete · <strong>{importResult.inserted}</strong> inserted,{" "}
          <strong>{importResult.updated}</strong> updated,{" "}
          <strong>{importResult.skipped}</strong> skipped
          {importResult.errors > 0 ? (
            <>
              , <strong>{importResult.errors}</strong> errors
            </>
          ) : null}
          <button
            type="button"
            className="assets-section__banner-close"
            onClick={() => setImportResult(null)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}

      {actionNotice && (
        <div className="assets-section__banner assets-section__banner--ok">
          {actionNotice}
          <button
            type="button"
            className="assets-section__banner-close"
            onClick={() => setActionNotice(null)}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}

      {error && (
        <div className="assets-section__banner assets-section__banner--err">
          {error}
          <button
            type="button"
            className="assets-section__banner-close"
            onClick={() => setError("")}
            aria-label="Close"
          >
            ×
          </button>
        </div>
      )}

      <AssetGroupTabs
        groups={groups}
        selectedGroup={selectedGroup}
        totalCount={assets.length}
        onSelect={setSelectedGroup}
      />

      {selectedIds.size > 0 && token && effectiveShipId && (
        <BulkEditBar
          token={token}
          shipId={effectiveShipId}
          selectedIds={[...selectedIds]}
          onDone={(updated) => {
            setSelectedIds(new Set());
            void reload();
            setError(
              updated === 0
                ? "Nothing was updated."
                : "",
            );
          }}
          onClear={() => setSelectedIds(new Set())}
        />
      )}


      {/* ─── MAIN: SIDEBAR + TABLE + DRAWER ─── */}
      <div className="assets-section__body">
        <AssetSubgroupSidebar
          search={search}
          onSearchChange={setSearch}
          searchInputRef={searchInputRef}
          searchActive={searchActive}
          matchCount={searchMatches.length}
          groupCount={groups.length}
          selectedGroup={selectedGroup}
          subgroups={subgroups}
          selectedSub={selectedSub}
          onSelectSub={setSelectedSub}
          groupTotal={assetsInGroup.length}
        />

        {/* MAIN TABLE */}
        <section className="assets-section__main">
          <div className="assets-section__main-stats">
            <div className="assets-section__main-stats-title">
              {currentGroupLabel}
              {currentSubLabel && (
                <span className="assets-section__main-stats-subtitle">
                  {currentSubLabel}
                </span>
              )}
            </div>
            <select
              className="admin-panel__th-filter assets-section__cov-filter"
              value={coverageFilter}
              onChange={(event) =>
                setCoverageFilter(
                  event.target.value as
                    | "all"
                    | "none"
                    | "no-manual"
                    | "no-metric",
                )
              }
              aria-label="Filter assets by coverage"
            >
              <option value="all">Coverage: all</option>
              <option value="none">Fully incomplete</option>
              <option value="no-manual">Missing manual</option>
              <option value="no-metric">Missing metrics</option>
            </select>
            <span className="assets-section__stat">
              <span className="assets-section__stat-label">Assets</span>
              <span className="assets-section__stat-value">{stats.total}</span>
            </span>
          </div>

          <AssetTable
            assets={sortedAssets}
            selectedAssetId={selectedAssetId}
            onSelectAsset={setSelectedAssetId}
            selectedIds={selectedIds}
            onToggleRow={toggleRow}
            allVisibleSelected={allVisibleSelected}
            someSelected={selectedAssets.length > 0}
            onToggleAll={toggleAllVisible}
            sort={sort}
            onToggleSort={toggleSort}
            savingAssetId={savingAssetId}
            makeFieldSaver={makeFieldSaver}
            loading={loading}
          />
        </section>

        {/* RIGHT DRAWER — asset detail (only when an asset is selected) */}
        {selectedAsset && (
          <AssetDrawer
            token={token}
            shipId={effectiveShipId}
            asset={selectedAsset}
            related={related}
            relatedLoading={relatedLoading}
            serviceRules={serviceRules}
            assetCerts={assetCerts}
            onClose={() => setSelectedAssetId(null)}
            onRefreshRelated={refreshRelated}
            onError={setError}
            makeFieldSaver={makeFieldSaver}
            onPatch={patchAsset}
          />
        )}
      </div>
    </div>
  );
}
