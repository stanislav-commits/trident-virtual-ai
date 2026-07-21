import { useCallback, useEffect, useRef, useState } from "react";
import { listAssets, type AssetItem } from "../../api/assetsApi";

export interface AssetsAdminData {
  assets: AssetItem[];
  total: number;
  loading: boolean;
  error: string;
  setError: (e: string) => void;
  reload: () => Promise<void>;
  /** Optimistic in-place edit of one asset (returns the prior list so the
   *  caller can roll back on a failed mutation). */
  patchAssetLocal: (assetId: string, patch: Partial<AssetItem>) => AssetItem[];
  /** Optimistic removal of one asset (returns the prior list for rollback). */
  removeAssetLocal: (assetId: string) => AssetItem[];
  /** Restore a previously-captured list after a failed optimistic change. */
  restoreAssets: (prev: AssetItem[]) => void;
}

export function useAssetsAdminData(
  token: string | null,
  shipId: string | null,
  enabled: boolean,
): AssetsAdminData {
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Always mirrors the committed list so optimistic helpers can capture the
  // exact prior state for rollback (a setState updater runs lazily, so reading
  // `prev` out of it synchronously would return a stale value).
  const assetsRef = useRef<AssetItem[]>(assets);
  assetsRef.current = assets;

  const reload = useCallback(async () => {
    if (!token || !shipId) {
      setAssets([]);
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      // Fetch a generous page — typical vessel has 1-2k assets and group/
      // subgroup derivation happens client-side from the same payload.
      const result = await listAssets(token, shipId, { limit: 2000 });
      setAssets(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load assets",
      );
    } finally {
      setLoading(false);
    }
  }, [shipId, token]);

  const patchAssetLocal = useCallback(
    (assetId: string, patch: Partial<AssetItem>): AssetItem[] => {
      const prev = assetsRef.current;
      setAssets((rows) =>
        rows.map((a) => (a.id === assetId ? { ...a, ...patch } : a)),
      );
      return prev;
    },
    [],
  );

  const removeAssetLocal = useCallback((assetId: string): AssetItem[] => {
    const prev = assetsRef.current;
    setAssets((rows) => rows.filter((a) => a.id !== assetId));
    return prev;
  }, []);

  const restoreAssets = useCallback((prev: AssetItem[]) => {
    setAssets(prev);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  return {
    assets,
    total,
    loading,
    error,
    setError,
    reload,
    patchAssetLocal,
    removeAssetLocal,
    restoreAssets,
  };
}
