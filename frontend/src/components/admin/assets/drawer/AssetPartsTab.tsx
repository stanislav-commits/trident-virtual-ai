import type {
  InventoryDraft,
  InventoryItem,
} from "../../../../api/inventoryApi";
import { InventorySuggestModal } from "../InventorySuggestModal";

/**
 * Spares that fit this equipment.
 *
 * The suggest button reads the asset's linked manual — without one there is
 * nothing to read, which is why the button says so rather than failing when
 * pressed.
 */
export function AssetPartsTab({
  parts,
  manualFileName,
  busy,
  preview,
  onSuggest,
  onCancelPreview,
  onConfirmPreview,
}: {
  parts: InventoryItem[];
  manualFileName: string | null;
  busy: boolean;
  preview: { drafts: InventoryDraft[]; notes: string[] } | null;
  onSuggest: () => void;
  onCancelPreview: () => void;
  onConfirmPreview: (drafts: InventoryDraft[]) => Promise<void>;
}) {
  return (
  <div className="assets-section__drawer-section">
    <div className="assets-section__pms-suggest">
      <button
        type="button"
        className="pms__btn"
        disabled={!manualFileName || busy}
        onClick={onSuggest}
        title={
          manualFileName
            ? `Suggest parts from ${manualFileName}`
            : "Link a manual to this asset first (Manuals tab)"
        }
      >
        {busy
          ? "Reading manual…"
          : manualFileName
            ? "Suggest parts from manual"
            : "Suggest parts (no manual linked)"}
      </button>
    </div>

    {parts.length === 0 ? (
      <div className="assets-section__placeholder">
        No parts linked to this asset yet. Use “Suggest parts from manual”,
        or add them in the Inventory section.
      </div>
    ) : (
      <>
      <div className="inv__table-wrap inv__table-wrap--asset">
        <table className="inv__table inv__table--asset">
          <thead>
            <tr>
              <th>Name</th>
              <th>Number</th>
              <th>Cat.</th>
              <th>Qty</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p.id} className="inv__row">
                <td className="inv__name">{p.name}</td>
                <td className="inv__mono">{p.partNumber ?? "—"}</td>
                <td><span className="inv__cat">{p.category}</span></td>
                <td>{p.quantity != null ? `${p.quantity}${p.unit ? " " + p.unit : ""}` : "—"}</td>
                <td className="inv__notes-cell" title={p.notes ?? ""}>{p.notes ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="inv__asset-count">{parts.length} part{parts.length === 1 ? "" : "s"} linked</p>
      </>
    )}

    {preview &&
      <InventorySuggestModal
        drafts={preview.drafts}
        notes={preview.notes}
        busy={busy}
        onCancel={onCancelPreview}
        onConfirm={onConfirmPreview}
      />}
  </div>
  );
}
