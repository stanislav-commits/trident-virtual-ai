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
import { AssetDrawer } from "./assets/AssetDrawer";
import { ImportPreviewModal } from "./assets/ImportPreviewModal";
import { EditableCell } from "./assets/EditableCell";
import { AssetFormModal } from "./assets/AssetFormModal";
import { ConfirmDialog } from "./assets/ConfirmDialog";
import {
  sfiColorForGroup,
  sfiGroupName,
} from "./assets/sfi-colors";

interface AssetsSectionProps {
  token: string | null;
}

const GROUP_ALL = "__all__";

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
 *   │    sub-group tree   │  │ in-service 30 · deprecated 1   │    │
 *   │  ╴ LOADED ASSETS    │  └────────────────────────────────┘    │
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

  const { assets, loading, error, reload, setError } = useAssetsAdminData(
    token,
    effectiveShipId,
    true,
  );

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

  const [selectedGroup, setSelectedGroup] = useState<string>(GROUP_ALL);
  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
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

  // Search query: when non-empty, scope switches to the whole vessel
  // (group + subgroup filters become inert) so users finding "watermaker"
  // while parked on group 2 still see results from group 7. Empty search
  // = the classic tab + sidebar drill-down.
  const searchActive = search.trim().length > 0;
  const groupCode = (a: AssetItem): string =>
    (a.sfiGroup ?? "?").toString().split(".")[0].replace(/^0/, "");

  // Search-matched subset of the whole catalog. Used by tabs / sidebar /
  // table when `searchActive`. Searches across the fields a user actually
  // remembers: SFI id, name, brand, model, sub code/name, location, zone,
  // deck role, space label, serial.
  const searchMatches = useMemo(() => {
    if (!searchActive) return assets;
    const q = search.trim().toLowerCase();
    return assets.filter(
      (a) =>
        a.assetIdInternal.toLowerCase().includes(q) ||
        a.displayName.toLowerCase().includes(q) ||
        (a.brand ?? "").toLowerCase().includes(q) ||
        (a.model ?? "").toLowerCase().includes(q) ||
        (a.sfiSub ?? "").toLowerCase().includes(q) ||
        (a.sfiSubName ?? "").toLowerCase().includes(q) ||
        (a.location ?? "").toLowerCase().includes(q) ||
        (a.serialNo ?? "").toLowerCase().includes(q) ||
        (a.zone ?? "").toLowerCase().includes(q) ||
        (a.deckRole ?? "").toLowerCase().includes(q) ||
        (a.spaceLabel ?? "").toLowerCase().includes(q),
    );
  }, [assets, search, searchActive]);

  // ── Group derivation (for tabs) ────────────────────────────────────────
  // When searching, counts reflect search-matched assets per group — so
  // the tab header tells you "13 matches in group 7" instead of the
  // unhelpful global total.
  const groups = useMemo(() => {
    const map = new Map<
      string,
      {
        code: string;
        name: string;
        count: number;
        inService: number;
        deprecated: number;
      }
    >();
    const source = searchActive ? searchMatches : assets;
    for (const a of source) {
      const key = groupCode(a);
      const existing = map.get(key) ?? {
        code: key,
        name: sfiNames.get(key) ?? sfiGroupName(key),
        count: 0,
        inService: 0,
        deprecated: 0,
      };
      existing.count += 1;
      if (a.lifecycleStatus === "in-service") existing.inService += 1;
      if (a.lifecycleStatus === "deprecated") existing.deprecated += 1;
      map.set(key, existing);
    }
    return Array.from(map.values()).sort((a, b) => {
      const an = Number(a.code) || 99;
      const bn = Number(b.code) || 99;
      return an - bn;
    });
  }, [assets, searchActive, searchMatches, sfiNames]);

  // ── Filter assets by group (search-aware) ──
  const assetsInGroup = useMemo(() => {
    const source = searchActive ? searchMatches : assets;
    if (selectedGroup === GROUP_ALL) return source;
    return source.filter((a) => groupCode(a) === selectedGroup);
  }, [assets, searchActive, searchMatches, selectedGroup]);

  // ── Subgroup tree for sidebar ──
  const subgroups = useMemo(() => {
    const map = new Map<
      string,
      { code: string; name: string; count: number }
    >();
    for (const a of assetsInGroup) {
      const code = (a.sfiSub ?? "—").toString();
      const existing = map.get(code);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(code, {
          code,
          name: sfiNames.get(code) ?? a.sfiSubName ?? code,
          count: 1,
        });
      }
    }
    // SFI codes are dotted decimals like "2.3", "3.1.4", "10.1". Naive
    // localeCompare sorts "10.1" before "2.3" (string order). Split into
    // numeric segments and compare segment-by-segment so the sidebar reads
    // 2.3 → 3.1 → 10.1, not 10.1 → 2.3 → 3.1.
    return Array.from(map.values()).sort((a, b) => {
      const ap = a.code.split(".").map((x) => parseInt(x, 10));
      const bp = b.code.split(".").map((x) => parseInt(x, 10));
      const len = Math.max(ap.length, bp.length);
      for (let i = 0; i < len; i += 1) {
        const av = Number.isFinite(ap[i]) ? ap[i] : Infinity;
        const bv = Number.isFinite(bp[i]) ? bp[i] : Infinity;
        if (av !== bv) return av - bv;
      }
      return a.code.localeCompare(b.code);
    });
  }, [assetsInGroup, sfiNames]);

  // ── Visible assets (sub filter only — search already applied above) ──
  const visibleAssets = useMemo(() => {
    let xs = assetsInGroup;
    if (selectedSub) {
      xs = xs.filter((a) => (a.sfiSub ?? "—") === selectedSub);
    }
    // When searching across the whole vessel, sort by group→sub→id so the
    // table reads in canonical hierarchy order rather than the load order.
    if (searchActive) {
      xs = [...xs].sort((a, b) => {
        const ag = Number(groupCode(a)) || 99;
        const bg = Number(groupCode(b)) || 99;
        if (ag !== bg) return ag - bg;
        return a.assetIdInternal.localeCompare(b.assetIdInternal);
      });
    }
    return xs;
  }, [assetsInGroup, selectedSub, searchActive]);

  // Reset subgroup when group changes
  useEffect(() => {
    setSelectedSub(null);
    setSelectedAssetId(null);
  }, [selectedGroup]);

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
      try {
        await updateAsset(token, effectiveShipId, assetId, patch);
        await reload();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Update failed");
        throw e;
      } finally {
        setSavingAssetId(null);
      }
    },
    [token, effectiveShipId, reload, setError],
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
    try {
      await deleteAsset(token, effectiveShipId, selectedAssetId);
      setConfirmDelete(false);
      setSelectedAssetId(null);
      setActionNotice("Asset deleted.");
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setActionBusy(false);
    }
  }, [token, effectiveShipId, selectedAssetId, reload]);

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
  }, [token, effectiveShipId, reload]);

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
    visibleAssets.find((a) => a.id === selectedAssetId) ??
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

      {/* ─── HORIZONTAL GROUP TABS ─── */}
      <nav className="assets-section__tabs" aria-label="SFI groups">
        <button
          type="button"
          className={`assets-section__tab ${
            selectedGroup === GROUP_ALL ? "assets-section__tab--active" : ""
          }`}
          style={{ ["--tab-color" as never]: "#94A3B8" }}
          onClick={() => setSelectedGroup(GROUP_ALL)}
        >
          <span className="assets-section__tab-code">ALL</span>
          <span className="assets-section__tab-name">All systems</span>
          <span className="assets-section__tab-meta">
            {assets.length} assets
          </span>
        </button>
        {groups.map((g) => {
          const color = sfiColorForGroup(g.code);
          const active = g.code === selectedGroup;
          return (
            <button
              key={g.code}
              type="button"
              className={`assets-section__tab ${active ? "assets-section__tab--active" : ""}`}
              style={{ ["--tab-color" as never]: color }}
              onClick={() => setSelectedGroup(g.code)}
            >
              <span className="assets-section__tab-code">
                {g.code.padStart(2, "0")}
              </span>
              <span className="assets-section__tab-name" title={g.name}>
                {g.name}
              </span>
              <span className="assets-section__tab-meta">
                {g.count} assets
              </span>
            </button>
          );
        })}
      </nav>

      {/* ─── MAIN: SIDEBAR + TABLE + DRAWER ─── */}
      <div className="assets-section__body">
        {/* LEFT SIDEBAR */}
        <aside className="assets-section__sidebar">
          <div className="assets-section__sidebar-search">
            <input
              ref={searchInputRef}
              type="search"
              className="assets-section__sidebar-input"
              placeholder="Search vessel (Cmd+K)…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && search) {
                  e.preventDefault();
                  setSearch("");
                }
              }}
            />
            {search && (
              <button
                type="button"
                className="assets-section__sidebar-clear"
                onClick={() => setSearch("")}
                title="Clear search (Esc)"
                aria-label="Clear search"
              >
                ×
              </button>
            )}
          </div>
          {searchActive && (
            <div className="assets-section__search-hint">
              {searchMatches.length} match{searchMatches.length === 1 ? "" : "es"}{" "}
              across {groups.length} group{groups.length === 1 ? "" : "s"}
            </div>
          )}
          <div className="assets-section__sidebar-section">
            <div className="assets-section__sidebar-head">
              Focused hierarchy{" "}
              <span className="assets-section__sidebar-head-tag">
                {selectedGroup === GROUP_ALL ? "all" : selectedGroup}
              </span>
            </div>
            <button
              type="button"
              className={`assets-section__sub ${selectedSub === null ? "assets-section__sub--active" : ""}`}
              onClick={() => setSelectedSub(null)}
            >
              <span className="assets-section__sub-code">—</span>
              <span className="assets-section__sub-name">
                All in {selectedGroup === GROUP_ALL ? "vessel" : `group ${selectedGroup}`}
              </span>
              <span className="assets-section__sub-count">
                {assetsInGroup.length}
              </span>
            </button>
            {subgroups.map((s) => (
              <button
                key={s.code}
                type="button"
                className={`assets-section__sub ${s.code === selectedSub ? "assets-section__sub--active" : ""}`}
                onClick={() => setSelectedSub(s.code)}
              >
                <span className="assets-section__sub-code">{s.code}</span>
                <span className="assets-section__sub-name" title={s.name}>
                  {s.name}
                </span>
                <span className="assets-section__sub-count">{s.count}</span>
              </button>
            ))}
          </div>

        </aside>

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
            <span className="assets-section__stat">
              <span className="assets-section__stat-label">Assets</span>
              <span className="assets-section__stat-value">{stats.total}</span>
            </span>
          </div>

          <div className="assets-section__table-wrap">
            <table className="assets-section__table">
              <thead>
                <tr>
                  <th>SFI</th>
                  <th>Name</th>
                  <th>Mfr</th>
                  <th>Model</th>
                  <th>Location</th>
                </tr>
              </thead>
              <tbody>
                {visibleAssets.map((a) => {
                  const groupKey = (a.sfiGroup ?? "")
                    .toString()
                    .split(".")[0]
                    .replace(/^0/, "");
                  const color = sfiColorForGroup(groupKey);
                  const active = a.id === selectedAssetId;
                  return (
                    <tr
                      key={a.id}
                      className={
                        active ? "assets-section__row--active" : undefined
                      }
                      onClick={() => setSelectedAssetId(a.id)}
                    >
                      <td className="assets-section__cell-mono">
                        <span
                          className="assets-section__row-dot"
                          style={{ background: color }}
                        />
                        <EditableCell
                          value={a.assetIdInternal}
                          saving={savingAssetId === a.id}
                          onSave={makeFieldSaver(a.id, "assetIdInternal")}
                        />
                      </td>
                      <td className="assets-section__cell-name">
                        <EditableCell
                          value={a.displayName}
                          saving={savingAssetId === a.id}
                          onSave={makeFieldSaver(a.id, "displayName")}
                        />
                      </td>
                      <td>
                        <EditableCell
                          value={a.brand}
                          saving={savingAssetId === a.id}
                          onSave={makeFieldSaver(a.id, "brand")}
                        />
                      </td>
                      <td>
                        <EditableCell
                          value={a.model}
                          saving={savingAssetId === a.id}
                          onSave={makeFieldSaver(a.id, "model")}
                        />
                      </td>
                      <td className="assets-section__cell-loc">
                        <EditableCell
                          value={a.location}
                          saving={savingAssetId === a.id}
                          onSave={makeFieldSaver(a.id, "location")}
                        />
                      </td>
                    </tr>
                  );
                })}
                {visibleAssets.length === 0 && !loading && (
                  <tr>
                    <td
                      colSpan={5}
                      className="assets-section__placeholder"
                      style={{ padding: "32px 16px" }}
                    >
                      No assets match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
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
