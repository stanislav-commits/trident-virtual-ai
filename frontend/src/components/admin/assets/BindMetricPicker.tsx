import { useEffect, useState } from "react";
import {
  fetchSimilarMetrics,
  searchShipMetrics,
  updateMetricBinding,
  type CatalogMetricListItem,
} from "../../../api/assetsApi";

interface BindMetricPickerProps {
  token: string | null;
  shipId: string;
  currentAssetId: string;
  alreadyBoundIds: Set<string>;
  onClose: () => void;
  onBound: () => void;
}

/**
 * Searchable picker for binding additional metrics to the current asset.
 * Lives inside the asset-detail drawer when "+ Add" is clicked.
 *
 * Shows the result list with a small badge indicating each metric's
 * current binding state:
 *   - "free"        — boundAssetId is null
 *   - "this"        — already bound to this asset (greyed out)
 *   - "other"       — bound to another asset (clicking will re-bind)
 *
 * Backend updates set `aiBoundConfidence` to 1.0 = human-verified.
 */
export function BindMetricPicker({
  token,
  shipId,
  currentAssetId,
  alreadyBoundIds,
  onClose,
  onBound,
}: BindMetricPickerProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CatalogMetricListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [savingId, setSavingId] = useState<string | null>(null);
  // After binding one metric, suggest its still-free same-device siblings so
  // the whole device can be bound in one click.
  const [suggested, setSuggested] = useState<CatalogMetricListItem[]>([]);
  const [bindingAll, setBindingAll] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError("");
    const handle = setTimeout(() => {
      // enabledOnly: disabled channels must never be bound to an asset.
      void searchShipMetrics(token, shipId, query, 1, 100, true)
        .then((r) => setItems(r.items))
        .catch((e) =>
          setError(e instanceof Error ? e.message : "Search failed"),
        )
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [token, shipId, query]);

  const handleBind = async (metric: CatalogMetricListItem) => {
    if (!token) return;
    setSavingId(metric.id);
    try {
      await updateMetricBinding(token, metric.id, currentAssetId);
      onBound();
      // Offer the rest of the same device (free siblings only).
      const siblings = await fetchSimilarMetrics(token, metric.id);
      setSuggested(
        siblings.filter(
          (s) => !s.boundAssetId && !alreadyBoundIds.has(s.id),
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bind failed");
    } finally {
      setSavingId(null);
    }
  };

  const handleBindAllSuggested = async () => {
    if (!token || suggested.length === 0) return;
    setBindingAll(true);
    try {
      for (const s of suggested) {
        await updateMetricBinding(token, s.id, currentAssetId);
      }
      onBound();
      setSuggested([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bind failed");
    } finally {
      setBindingAll(false);
    }
  };

  return (
    <div className="bind-picker">
      <div className="bind-picker__head">
        <span className="bind-picker__title">Bind metric to this asset</span>
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
        placeholder="Search by key, field, description…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <div className="bind-picker__error">{error}</div>}
      {suggested.length > 0 && (
        <div className="bind-picker__suggest">
          <span className="bind-picker__suggest-copy">
            {suggested.length} more metric{suggested.length === 1 ? "" : "s"} from
            the same device are free.
          </span>
          <button
            type="button"
            className="bind-picker__suggest-btn"
            disabled={bindingAll}
            onClick={() => void handleBindAllSuggested()}
          >
            {bindingAll ? "Binding…" : `Bind all ${suggested.length} here`}
          </button>
          <button
            type="button"
            className="bind-picker__suggest-dismiss"
            onClick={() => setSuggested([])}
            aria-label="Dismiss suggestion"
          >
            ×
          </button>
        </div>
      )}
      {loading && <div className="bind-picker__placeholder">Loading…</div>}
      {!loading && items.length === 0 && (
        <div className="bind-picker__placeholder">
          {query.trim() ? "No metrics match." : "Start typing to search."}
        </div>
      )}
      <div className="bind-picker__list">
        {items.map((m) => {
          const isThis = m.boundAssetId === currentAssetId;
          const isOther =
            m.boundAssetId !== null && m.boundAssetId !== currentAssetId;
          const isAlreadyShown = alreadyBoundIds.has(m.id);
          return (
            <button
              key={m.id}
              type="button"
              className={`bind-picker__row ${
                isThis || isAlreadyShown ? "bind-picker__row--disabled" : ""
              }`}
              disabled={isThis || isAlreadyShown || savingId === m.id}
              onClick={() => void handleBind(m)}
              title={m.aiDescription ?? m.description ?? undefined}
            >
              <span className="bind-picker__row-key">{m.key}</span>
              <span className="bind-picker__row-meta">
                {m.aiUnit ?? m.aiKind ?? ""}
              </span>
              {isThis && (
                <span className="bind-picker__row-badge bind-picker__row-badge--this">
                  bound here
                </span>
              )}
              {isOther && (
                <span className="bind-picker__row-badge bind-picker__row-badge--other">
                  bound elsewhere
                </span>
              )}
              {!isThis && !isOther && (
                <span className="bind-picker__row-badge bind-picker__row-badge--free">
                  free
                </span>
              )}
              {savingId === m.id && (
                <span className="bind-picker__row-badge">…</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
