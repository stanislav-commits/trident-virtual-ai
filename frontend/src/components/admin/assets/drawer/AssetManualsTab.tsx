import { LinkManualPicker } from "../LinkManualPicker";
import type { RelatedAssetResult } from "../../../../api/assetsApi";

type LinkedDocument = RelatedAssetResult["documents"][number];

/**
 * Knowledge-base documents pinned to this asset.
 *
 * Certificates and drawings are deliberately absent — they have their own tab
 * and their own block, and listing them here made the count on the tab
 * disagree with what the tab showed.
 */
export function AssetManualsTab({
  token,
  shipId,
  assetId,
  related,
  relatedLoading,
  manualDocs,
  pickerOpen,
  onTogglePicker,
  onClosePicker,
  onRefreshRelated,
  unlinkingDocId,
  onUnlink,
  onOpenDocument,
}: {
  token: string | null;
  shipId: string;
  assetId: string;
  related: RelatedAssetResult | null;
  relatedLoading: boolean;
  manualDocs: LinkedDocument[];
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onClosePicker: () => void;
  onRefreshRelated: () => Promise<void> | void;
  unlinkingDocId: string | null;
  onUnlink: (documentId: string) => void;
  onOpenDocument: (documentId: string, fileName: string) => void;
}) {
  return (
  <div className="assets-section__drawer-section">
    <div className="assets-section__drawer-section-head">
      Linked manuals
      <button
        type="button"
        className="assets-section__drawer-section-btn"
        onClick={onTogglePicker}
      >
        {pickerOpen ? "× Cancel" : "+ Link"}
      </button>
    </div>
    <div className="assets-section__drawer-section-note">
      Explicit pins + brand/model auto-matches. × on a pinned doc
      removes the link; × on an auto-match hides it permanently
      (re-link via + Link to undo).
    </div>
    {pickerOpen && (
      <LinkManualPicker
        token={token}
        shipId={shipId}
        currentAssetId={assetId}
        alreadyLinkedIds={new Set(related?.documents.map((d) => d.id) ?? [])}
        onClose={onClosePicker}
        onLinked={() => {
          void onRefreshRelated();
          onClosePicker();
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
            onClick={() => onOpenDocument(d.id, d.originalFileName)}
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
            onClick={() => onUnlink(d.id)}
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
  );
}
