import { useEffect, useState } from "react";
import type {
  AssetItem,
  RelatedAssetResult,
  UpdateAssetInput,
} from "../../../../api/assetsApi";
import { fetchSfiGroups, fetchSfiSubs, type SfiNode } from "../../../../api/sfiApi";
import { AssetSelect, type AssetOption } from "../../AssetMultiSelect";
import { EditableCell } from "../EditableCell";

/**
 * SFI group / sub-group selectors driven by the taxonomy catalog. Picking a
 * group saves code+name and clears the sub pair; picking a sub saves its
 * code+name. The names themselves are never hand-edited.
 */
function SfiCascadeRows({
  token,
  asset,
  onPatch,
}: {
  token: string | null;
  asset: AssetItem;
  onPatch: (assetId: string, patch: UpdateAssetInput) => Promise<void>;
}) {
  const [groups, setGroups] = useState<SfiNode[]>([]);
  const [subs, setSubs] = useState<SfiNode[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    void fetchSfiGroups(token)
      .then(setGroups)
      .catch(() => setGroups([]));
  }, [token]);

  useEffect(() => {
    if (!token || !asset.sfiGroup) {
      setSubs([]);
      return;
    }
    void fetchSfiSubs(token, asset.sfiGroup)
      .then(setSubs)
      .catch(() => setSubs([]));
  }, [token, asset.sfiGroup]);

  const pickGroup = async (code: string) => {
    const group = groups.find((g) => g.code === code);
    setBusy(true);
    try {
      await onPatch(asset.id, {
        sfiGroup: code || null,
        sfiGroupName: group?.name ?? null,
        // group change invalidates the previous sub pair
        sfiSub: null,
        sfiSubName: null,
      });
    } finally {
      setBusy(false);
    }
  };

  const pickSub = async (code: string) => {
    const sub = subs.find((s) => s.code === code);
    setBusy(true);
    try {
      await onPatch(asset.id, {
        sfiSub: code || null,
        sfiSubName: sub?.name ?? null,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="assets-section__field assets-section__field--half">
        <span className="assets-section__field-label">SFI group</span>
        <select
          className="assets-section__field-select"
          value={asset.sfiGroup ?? ""}
          disabled={busy}
          onChange={(e) => void pickGroup(e.target.value)}
        >
          <option value="">—</option>
          {groups.map((g) => (
            <option key={g.code} value={g.code}>
              {g.code} — {g.name}
            </option>
          ))}
        </select>
      </div>
      <div className="assets-section__field assets-section__field--half">
        <span className="assets-section__field-label">SFI sub</span>
        <select
          className="assets-section__field-select"
          value={asset.sfiSub ?? ""}
          disabled={busy || !asset.sfiGroup}
          onChange={(e) => void pickSub(e.target.value)}
        >
          <option value="">{asset.sfiGroup ? "—" : "Select group first"}</option>
          {subs.map((s) => (
            <option key={s.code} value={s.code}>
              {s.code} — {s.name}
            </option>
          ))}
        </select>
      </div>
    </>
  );
}

function OverviewFieldRow({
  label,
  value,
  onSave,
  placeholder,
  width,
  pickAssets,
}: {
  label: string;
  value: string | null;
  /** When present the field is editable; otherwise read-only. */
  onSave?: (next: string | null) => Promise<void> | void;
  placeholder?: string;
  width?: "full" | "half";
  /** When present, the field is an asset picker instead of free text. */
  pickAssets?: AssetOption[];
}) {
  return (
    <div
      className={`assets-section__field assets-section__field--${
        width ?? "half"
      }`}
    >
      <span className="assets-section__field-label">{label}</span>
      {onSave ? (
        pickAssets ? (
          <AssetSelect
            assets={pickAssets}
            value={value}
            onChange={(id) => void onSave(id)}
            placeholder={placeholder ?? "Link asset…"}
          />
        ) : (
          <EditableCell
            value={value}
            placeholder={placeholder ?? "—"}
            onSave={onSave}
          />
        )
      ) : (
        <span className="assets-section__field-readonly">{value ?? "—"}</span>
      )}
    </div>
  );
}
/**
 * The asset's own columns, plus the drawings pinned to it.
 *
 * Every field edits in place; identity fields (brand, model) route through the
 * caller so a change can prompt a review of the type approvals that describe
 * the old equipment.
 */
export function AssetOverviewTab({
  token,
  asset,
  drawings,
  registerOptions,
  onPatch,
  save,
  saveIdentity,
  unlinkingDocId,
  onUnlink,
  onOpenDocument,
}: {
  token: string | null;
  asset: AssetItem;
  drawings: RelatedAssetResult["drawings"];
  registerOptions: AssetOption[];
  onPatch: (assetId: string, patch: UpdateAssetInput) => Promise<void>;
  save: (field: keyof UpdateAssetInput) => (next: string | null) => Promise<void>;
  saveIdentity: (field: "brand" | "model") => (next: string | null) => Promise<void>;
  unlinkingDocId: string | null;
  onUnlink: (documentId: string) => void;
  onOpenDocument: (documentId: string, fileName: string) => void;
}) {
  return (
  <div className="assets-section__drawer-section">
    {/* Only the columns present in the final register format (14-col). */}
    <div className="assets-section__drawer-fields">
      {/* SFI comes from the taxonomy: pick group → sub. The dropdown
          labels already carry the group/sub NAME, so no separate
          name rows here. */}
      <SfiCascadeRows token={token} asset={asset} onPatch={onPatch} />
      <OverviewFieldRow label="Brand" value={asset.brand} onSave={saveIdentity("brand")} />
      <OverviewFieldRow label="Model" value={asset.model} onSave={saveIdentity("model")} />
      <OverviewFieldRow label="Serial №" value={asset.serialNo} onSave={save("serialNo")} />
      <OverviewFieldRow
        label="Served by"
        value={asset.servedByAssetId}
        onSave={save("servedByAssetId")}
        placeholder="link the serving asset…"
        pickAssets={registerOptions.filter(
          (o) => o.id !== asset.assetIdInternal,
        )}
      />
      <OverviewFieldRow label="Location" value={asset.location} onSave={save("location")} width="full" />
      <OverviewFieldRow label="Drawing ref" value={asset.drawingRef} onSave={save("drawingRef")} />
      <OverviewFieldRow label="Drawing code" value={asset.drawingCode} onSave={save("drawingCode")} />
      <OverviewFieldRow label="Notes" value={asset.notes} onSave={save("notes")} width="full" />
    </div>

    {/* Drawings — file pointers (never parsed): explicit links + register
        drawing-code matches. Click to open the original. */}
    {drawings.length > 0 && (
      <div className="assets-section__drawings">
        <div className="assets-section__drawer-section-head">Drawings</div>
        {drawings.map((d) => (
          <div
            key={d.id}
            className="assets-section__doc-row assets-section__doc-row--clickable"
          >
            <button
              type="button"
              className="assets-section__doc-row-main"
              onClick={() => onOpenDocument(d.id, d.originalFileName)}
              title="Click to open the drawing"
            >
              <span className="assets-section__doc-name">
                📐 {d.originalFileName}
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
                {d.linkSource === "explicit"
                  ? "linked"
                  : `matched by drawing ref ${asset.drawingCode ?? asset.drawingRef ?? ""}`}
              </span>
            </button>
            <button
              type="button"
              className="assets-section__metric-unbind"
              onClick={() => onUnlink(d.id)}
              disabled={unlinkingDocId === d.id}
              aria-label={`Detach ${d.originalFileName}`}
              title={
                d.linkSource === "explicit"
                  ? "Remove this drawing link"
                  : "Wrong match — hide this drawing for this asset permanently"
              }
            >
              {unlinkingDocId === d.id ? "…" : "×"}
            </button>
          </div>
        ))}
      </div>
    )}
  </div>
  );
}
