import { useCallback, useMemo, useState } from "react";
import type { AssetItem } from "../../api/assetsApi";
import { sfiGroupName } from "../../components/admin/assets/sfi-colors";

export const GROUP_ALL = "__all__";

export type CoverageFilter = "all" | "none" | "no-manual" | "no-metric";
export type SortKey =
  | "assetIdInternal"
  | "displayName"
  | "brand"
  | "model"
  | "location";

export interface SfiNode {
  code: string;
  name: string;
  count: number;
}

/** The register's top-level group, as it appears in the asset's SFI code. */
export const groupCode = (a: AssetItem): string =>
  (a.sfiGroup ?? "?").toString().split(".")[0].replace(/^0/, "");

/**
 * Everything the register view derives from the loaded assets: what the search
 * matches, which groups and sub-groups exist, which rows are on screen, how
 * they are sorted and which are ticked.
 *
 * It is a chain — search narrows the catalogue, the group tab narrows that, the
 * sub-group narrows that again, coverage filters it, and the column sort is
 * applied last so it beats the canonical hierarchy order. Pulled out of
 * AssetsSection because the chain is the part that has to be right; leaving it
 * interleaved with modals and banners made it impossible to read in one go.
 */
export function useAssetRegisterView(
  assets: AssetItem[],
  sfiNames: Map<string, string>,
) {
  const [selectedGroup, setSelectedGroupState] = useState<string>(GROUP_ALL);
  const [selectedSub, setSelectedSub] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [coverageFilter, setCoverageFilter] = useState<CoverageFilter>("all");
  /**
   * Rows ticked for a bulk action. Ids rather than indices: the visible set is
   * re-derived on every filter change and a selection must survive that — you
   * pick a few in one sub-group, switch to another, and apply to both.
   */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(
    null,
  );

  /**
   * Changing the system drops the sub-group focus and closes the drawer — done
   * here rather than in an effect, so the three land in one render instead of a
   * second pass that briefly shows a sub-group belonging to the old group.
   */
  const setSelectedGroup = useCallback((code: string) => {
    setSelectedGroupState(code);
    setSelectedSub(null);
    setSelectedAssetId(null);
  }, []);

  /**
   * Search query: when non-empty, scope switches to the whole vessel (group +
   * subgroup filters become inert) so users finding "watermaker" while parked
   * on group 2 still see results from group 7. Empty search = the classic tab
   * + sidebar drill-down.
   */
  const searchActive = search.trim().length > 0;

  // Searches across the fields a user actually remembers: SFI id, name, brand,
  // model, sub code/name, location, zone, deck role, space label, serial.
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

  // When searching, counts reflect search-matched assets per group — so the tab
  // header tells you "13 matches in group 7" instead of the unhelpful global
  // total.
  const groups = useMemo<SfiNode[]>(() => {
    const map = new Map<string, SfiNode>();
    const source = searchActive ? searchMatches : assets;
    for (const a of source) {
      const key = groupCode(a);
      const existing = map.get(key) ?? {
        code: key,
        name: sfiNames.get(key) ?? sfiGroupName(key),
        count: 0,
      };
      existing.count += 1;
      map.set(key, existing);
    }
    return Array.from(map.values()).sort((a, b) => {
      const an = Number(a.code) || 99;
      const bn = Number(b.code) || 99;
      return an - bn;
    });
  }, [assets, searchActive, searchMatches, sfiNames]);

  const assetsInGroup = useMemo(() => {
    const source = searchActive ? searchMatches : assets;
    if (selectedGroup === GROUP_ALL) return source;
    return source.filter((a) => groupCode(a) === selectedGroup);
  }, [assets, searchActive, searchMatches, selectedGroup]);

  const subgroups = useMemo<SfiNode[]>(() => {
    const map = new Map<string, SfiNode>();
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

  // Sub filter + coverage — search is already applied above.
  const visibleAssets = useMemo(() => {
    let xs = assetsInGroup;
    if (selectedSub) {
      xs = xs.filter((a) => (a.sfiSub ?? "—") === selectedSub);
    }
    if (coverageFilter !== "all") {
      xs = xs.filter((a) => {
        const hasManual = (a.manualCount ?? 0) > 0;
        const hasMetric = (a.metricCount ?? 0) > 0;
        if (coverageFilter === "none") return !hasManual && !hasMetric;
        if (coverageFilter === "no-manual") return !hasManual;
        return !hasMetric;
      });
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
  }, [assetsInGroup, selectedSub, searchActive, coverageFilter]);

  /**
   * Column sort, applied last so it overrides the canonical hierarchy order.
   * Null means "leave the register in its own order" — which is the right
   * default for a positional id like SWX.4.1.05.
   */
  const sortedAssets = useMemo(() => {
    if (!sort) return visibleAssets;
    const dir = sort.dir === "asc" ? 1 : -1;
    return [...visibleAssets].sort((a, b) => {
      const av = (a[sort.key] ?? "").toString();
      const bv = (b[sort.key] ?? "").toString();
      // Empty cells sink regardless of direction: a column is sorted to find
      // values, and a wall of blanks at the top helps nobody.
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return av.localeCompare(bv, undefined, { numeric: true }) * dir;
    });
  }, [visibleAssets, sort]);

  const toggleSort = useCallback((key: SortKey) => {
    setSort((prev) =>
      prev?.key !== key
        ? { key, dir: "asc" }
        : prev.dir === "asc"
          ? { key, dir: "desc" }
          : null,
    );
  }, []);

  const selectedAssets = useMemo(
    () => sortedAssets.filter((a) => selectedIds.has(a.id)),
    [sortedAssets, selectedIds],
  );
  const allVisibleSelected =
    sortedAssets.length > 0 && selectedAssets.length === sortedAssets.length;

  const toggleRow = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const ids = sortedAssets.map((a) => a.id);
      const every = ids.every((id) => next.has(id));
      // Only the rows on screen are touched — a selection made in another
      // sub-group is not silently thrown away by a header click here.
      for (const id of ids) {
        if (every) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, [sortedAssets]);

  return {
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
  };
}
