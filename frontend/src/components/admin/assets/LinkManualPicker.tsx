import { useEffect, useState } from "react";
import { linkAssetDocument } from "../../../api/assetsApi";
import {
  listDocuments,
  type DocumentListItem,
} from "../../../api/documentsApi";

interface LinkManualPickerProps {
  token: string | null;
  shipId: string;
  currentAssetId: string;
  /** Document IDs already linked (auto or explicit) — shown as disabled. */
  alreadyLinkedIds: Set<string>;
  onClose: () => void;
  onLinked: () => void;
}

/**
 * Search the ship's documents and explicitly pin one to the current asset.
 * Lives inside the asset-detail drawer when "+ Link manual" is clicked.
 * Calls POST /ships/:shipId/assets/:assetId/documents/:documentId — that
 * endpoint is idempotent so the picker doesn't need to track state itself.
 */
export function LinkManualPicker({
  token,
  shipId,
  currentAssetId,
  alreadyLinkedIds,
  onClose,
  onLinked,
}: LinkManualPickerProps) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DocumentListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [linkingId, setLinkingId] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError("");
    const handle = setTimeout(() => {
      void listDocuments(token, {
        shipId,
        name: query.trim() || undefined,
        pageSize: 60,
        page: 1,
      })
        .then((r) => setItems(r.items))
        .catch((e) =>
          setError(e instanceof Error ? e.message : "Search failed"),
        )
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [token, shipId, query]);

  const handleLink = async (doc: DocumentListItem) => {
    if (!token) return;
    setLinkingId(doc.id);
    try {
      await linkAssetDocument(token, shipId, currentAssetId, doc.id);
      onLinked();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Link failed");
    } finally {
      setLinkingId(null);
    }
  };

  return (
    <div className="bind-picker">
      <div className="bind-picker__head">
        <span className="bind-picker__title">Link manual to this asset</span>
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
        placeholder="Search by filename, brand, model…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && <div className="bind-picker__error">{error}</div>}
      {loading && <div className="bind-picker__placeholder">Loading…</div>}
      {!loading && items.length === 0 && (
        <div className="bind-picker__placeholder">
          {query.trim()
            ? "No documents match."
            : "No documents for this ship yet — upload some in Documents."}
        </div>
      )}
      <div className="bind-picker__list">
        {items.map((d) => {
          const already = alreadyLinkedIds.has(d.id);
          return (
            <button
              key={d.id}
              type="button"
              className={`bind-picker__row ${already ? "bind-picker__row--disabled" : ""}`}
              disabled={already || linkingId === d.id}
              onClick={() => void handleLink(d)}
              title={d.equipmentName ?? d.originalFileName}
            >
              <span className="bind-picker__row-key">📄 {d.originalFileName}</span>
              <span className="bind-picker__row-meta">
                {d.manufacturer ?? "—"}
                {d.model ? ` · ${d.model}` : ""}
              </span>
              {already ? (
                <span className="bind-picker__row-badge bind-picker__row-badge--this">
                  linked
                </span>
              ) : (
                <span className="bind-picker__row-badge bind-picker__row-badge--free">
                  link
                </span>
              )}
              {linkingId === d.id && (
                <span className="bind-picker__row-badge">…</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
