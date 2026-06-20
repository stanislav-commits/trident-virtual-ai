import { useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "../AdminPanelIcons";
import {
  INVENTORY_CATEGORIES,
  type InventoryDraft,
} from "../../../api/inventoryApi";

interface Row extends InventoryDraft {
  _key: string;
  _include: boolean;
}

/** Review AI-suggested parts before adding them to inventory. */
export function InventorySuggestModal({
  drafts,
  notes,
  busy,
  onCancel,
  onConfirm,
}: {
  drafts: InventoryDraft[];
  notes: string[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (drafts: InventoryDraft[]) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() =>
    drafts.map((d, i) => ({ ...d, _key: `d${i}`, _include: true })),
  );
  const patch = (k: string, n: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r._key === k ? { ...r, ...n } : r)));
  const included = rows.filter((r) => r._include).length;

  const confirm = () =>
    onConfirm(
      rows
        .filter((r) => r._include && r.name.trim())
        .map(({ _key, _include, ...d }) => {
          void _key;
          void _include;
          return d;
        }),
    );

  return createPortal(
    <div className="admin-panel__modal-overlay" onClick={onCancel}>
      <div className="admin-panel__modal pms__import-modal" onClick={(e) => e.stopPropagation()}>
        <div className="admin-panel__modal-header">
          <h3>Suggested parts · {drafts.length}</h3>
          <button type="button" className="admin-panel__icon-btn" onClick={onCancel}><XIcon /></button>
        </div>
        {notes.map((n, i) => <div key={i} className="pms__import-note">{n}</div>)}
        <div className="pms__import-table-wrap">
          <table className="pms__table pms__import-table">
            <thead>
              <tr><th></th><th>Name</th><th>Part №</th><th>Category</th><th>Qty</th><th>Notes</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r._key} className={r._include ? "" : "pms__import-row--off"}>
                  <td><input type="checkbox" checked={r._include} onChange={(e) => patch(r._key, { _include: e.target.checked })} /></td>
                  <td><input className="pms__import-input" value={r.name} onChange={(e) => patch(r._key, { name: e.target.value })} /></td>
                  <td><input className="pms__import-input" value={r.partNumber ?? ""} onChange={(e) => patch(r._key, { partNumber: e.target.value })} /></td>
                  <td>
                    <select className="pms__import-input" value={r.category ?? "part"} onChange={(e) => patch(r._key, { category: e.target.value })}>
                      {INVENTORY_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </td>
                  <td>
                    <input className="pms__import-input" style={{ width: 70 }} value={r.quantity ?? ""} placeholder={r.unit ?? ""}
                      onChange={(e) => patch(r._key, { quantity: e.target.value === "" ? null : (Number(e.target.value.replace(/[^0-9.]/g, "")) || null) })} />
                  </td>
                  <td>
                    <input className="pms__import-input" value={r.notes ?? ""} placeholder="spec / usage"
                      onChange={(e) => patch(r._key, { notes: e.target.value })} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="admin-panel__modal-actions">
          <button type="button" className="admin-panel__btn admin-panel__btn--ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="admin-panel__btn admin-panel__btn--primary" onClick={confirm} disabled={busy || included === 0}>
            {busy ? "Adding…" : `Add ${included} part${included === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
