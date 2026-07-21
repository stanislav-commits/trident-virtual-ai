import { useEffect, useState } from "react";
import {
  listAssets,
  updateMetricBinding,
  type AssetItem,
} from "../../../api/assetsApi";

interface BindAssetPickerProps {
  token: string | null;
  shipId: string;
  metricId: string;
  /** Currently bound asset's id_internal, if any — shown as disabled. */
  currentAssetIdInternal: string | null;
  onClose: () => void;
  /** Fires with the just-bound asset so the parent can update its list
   *  optimistically instead of refetching. */
  onBound: (asset: {
    id: string;
    assetIdInternal: string;
    displayName: string;
  }) => void;
}

/**
 * Mirror of BindMetricPicker but in the other direction: search the ship's
 * asset register and bind one to the given metric. Used in the Metrics admin
 * tab so admins don't have to navigate to Assets → drawer → picker just to
 * fix a single binding.
 *
 * Re-uses the same backend endpoint (`PATCH metrics/catalog/:id` with
 * `boundAssetId`) — so confidence is stamped to 1.0 ("human verified") on
 * the server side.
 */
export function BindAssetPicker({
  token,
  shipId,
  metricId,
  currentAssetIdInternal,
  onClose,
  onBound,
}: BindAssetPickerProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [bindingId, setBindingId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError("");
    const handle = setTimeout(() => {
      void listAssets(token, shipId, {
        search: query.trim() || undefined,
        limit: 60,
      })
        .then((r) => setItems(r.items))
        .catch((e) =>
          setError(e instanceof Error ? e.message : "Search failed"),
        )
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [token, shipId, query]);

  const handleBind = async (asset: AssetItem) => {
    if (!token) return;
    setBindingId(asset.id);
    try {
      await updateMetricBinding(token, metricId, asset.id);
      onBound({
        id: asset.id,
        assetIdInternal: asset.assetIdInternal,
        displayName: asset.displayName,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bind failed");
    } finally {
      setBindingId(null);
    }
  };

  return (
    <div className="bind-picker">
      <div className="bind-picker__head">
        <span className="bind-picker__title">Bind metric to asset</span>
        <button
          type="button"
          className="bind-picker__close"
          onClick={onClose}
          aria-label="Close picker"
        >
          ×
        </button>
      </div>
      <input
        autoFocus
        type="search"
        className="bind-picker__input"
        placeholder="Search by SFI code, name, brand…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <div className="bind-picker__error">{error}</div>}
      {loading && <div className="bind-picker__placeholder">Loading…</div>}
      {!loading && items.length === 0 && (
        <div className="bind-picker__placeholder">
          {query.trim()
            ? "No assets match."
            : "Start typing — SFI code, equipment name, brand or model."}
        </div>
      )}
      <div className="bind-picker__list">
        {items.map((a) => {
          const isCurrent =
            currentAssetIdInternal !== null &&
            a.assetIdInternal === currentAssetIdInternal;
          return (
            <button
              key={a.id}
              type="button"
              className={`bind-picker__row ${isCurrent ? "bind-picker__row--disabled" : ""}`}
              disabled={isCurrent || bindingId === a.id}
              onClick={() => void handleBind(a)}
              title={a.displayName}
            >
              <span className="bind-picker__row-key">
                {a.assetIdInternal} · {a.displayName}
              </span>
              <span className="bind-picker__row-meta">
                {a.brand ?? "—"}
                {a.model ? ` · ${a.model}` : ""}
                {a.location ? ` · ${a.location}` : ""}
              </span>
              {isCurrent ? (
                <span className="bind-picker__row-badge bind-picker__row-badge--this">
                  current
                </span>
              ) : (
                <span className="bind-picker__row-badge bind-picker__row-badge--free">
                  bind
                </span>
              )}
              {bindingId === a.id && (
                <span className="bind-picker__row-badge">…</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
