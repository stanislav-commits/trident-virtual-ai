import { useState } from "react";
import { bulkUpdateAssets, type BulkAssetPatch } from "../../../api/assetsApi";

const FIELDS = [
  { key: "location", label: "Location", placeholder: "Engine room, stbd" },
  { key: "brand", label: "Manufacturer", placeholder: "MASE" },
  { key: "model", label: "Model", placeholder: "VS-350-SV" },
  { key: "notes", label: "Notes", placeholder: "" },
] as const;

const DEPARTMENTS = ["engine", "deck", "interior", "galley"] as const;

/**
 * Apply one value to every ticked row.
 *
 * The register's operational columns sit empty not for want of a place to put
 * them but because filling 1500 of them one drawer at a time is not work anyone
 * does. This is the other way in.
 *
 * Identity — asset id, name, serial — is deliberately absent: those are
 * per-unit facts, and setting them for a selection could only ever be a
 * mistake. Clearing is explicit, via the Clear button, so an empty box left
 * untouched never wipes a column by accident.
 */
export function BulkEditBar({
  token,
  shipId,
  selectedIds,
  onDone,
  onClear,
}: {
  token: string;
  shipId: string;
  selectedIds: string[];
  onDone: (updated: number) => void;
  onClear: () => void;
}) {
  const [field, setField] = useState<string>("location");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (clear: boolean) => {
    if (!clear && !value.trim()) {
      setError("Type a value, or use Clear to empty the field.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const patch: BulkAssetPatch = {
        [field]: clear ? null : value.trim(),
      } as BulkAssetPatch;
      const { updated } = await bulkUpdateAssets(
        token,
        shipId,
        selectedIds,
        patch,
      );
      setValue("");
      onDone(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bulkbar">
      <span className="bulkbar__count">
        {selectedIds.length} selected
      </span>

      <select
        className="bulkbar__field"
        value={field}
        onChange={(e) => {
          setField(e.target.value);
          setValue("");
        }}
        disabled={busy}
      >
        {FIELDS.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
        <option value="department">Department</option>
      </select>

      {field === "department" ? (
        <select
          className="bulkbar__value"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
        >
          <option value="">choose…</option>
          {DEPARTMENTS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="bulkbar__value"
          value={value}
          placeholder={FIELDS.find((f) => f.key === field)?.placeholder ?? ""}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void apply(false);
          }}
          disabled={busy}
        />
      )}

      <button
        type="button"
        className="bulkbar__apply"
        onClick={() => void apply(false)}
        disabled={busy}
      >
        {busy ? "Applying…" : `Apply to ${selectedIds.length}`}
      </button>
      <button
        type="button"
        className="bulkbar__clear-field"
        onClick={() => void apply(true)}
        disabled={busy}
        title="Empty this field on the selected assets"
      >
        Clear field
      </button>
      <button type="button" className="bulkbar__dismiss" onClick={onClear}>
        Deselect
      </button>

      {error && <span className="bulkbar__error">{error}</span>}
    </div>
  );
}
