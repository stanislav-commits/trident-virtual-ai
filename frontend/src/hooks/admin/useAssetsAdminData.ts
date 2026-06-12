import { useCallback, useEffect, useState } from "react";
import { listAssets, type AssetItem } from "../../api/assetsApi";

export interface AssetsAdminData {
  assets: AssetItem[];
  total: number;
  loading: boolean;
  error: string;
  setError: (e: string) => void;
  reload: () => Promise<void>;
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

  useEffect(() => {
    if (!enabled) return;
    void reload();
  }, [enabled, reload]);

  return { assets, total, loading, error, setError, reload };
}
