import { useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "./AdminPanelIcons";
import type { ArchetypeField } from "../../api/complianceApi";
import { prettyLabel, inputTypeFor } from "./compliance/complianceLabels";

/**
 * Map extracted / saved values onto the schema's field keys. The AI often keys
 * a compound schema field (e.g. `vessel_gt/imo/callsign/flag`) by its parts
 * (`vessel_gt`, `vessel_imo`), so gather those into the compound key instead of
 * losing them. Simple keys match exactly.
 */
function foldToSchema(
  fieldKeys: string[],
  raw: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const k of fieldKeys) {
    if (raw[k] != null && raw[k] !== "") {
      out[k] = raw[k];
      used.add(k);
    }
  }
  for (const k of fieldKeys) {
    if (!k.includes("/") || out[k]) continue;
    const parts = k.split("/");
    const first = parts[0];
    const us = first.lastIndexOf("_");
    const prefix = us >= 0 ? first.slice(0, us + 1) : "";
    const comps = [first.slice(prefix.length), ...parts.slice(1)];
    const cand = new Set<string>();
    for (const c of comps) {
      cand.add(c);
      if (prefix) cand.add(prefix + c);
    }
    const pieces: string[] = [];
    for (const [rk, rv] of Object.entries(raw)) {
      if (used.has(rk) || rv == null || rv === "") continue;
      if (cand.has(rk)) {
        const label = prefix && rk.startsWith(prefix) ? rk.slice(prefix.length) : rk;
        pieces.push(`${label.toUpperCase()}: ${rv}`);
        used.add(rk);
      }
    }
    if (pieces.length) out[k] = pieces.join(", ");
  }
  return out;
}

export interface DocModalValues {
  certNo: string;
  issuer: string;
  issueDate: string;
  assetLabel: string;
  fields: Record<string, string>;
}

interface ComplianceDocModalProps {
  typeName: string;
  typeCode: string;
  archetype: string | null;
  /** The archetype's field block from the schema — drives which fields show. */
  archetypeFields: ArchetypeField[];
  linkCardinality: string | null;
  assetOptions: Array<{ id: string; label: string }>;
  crewOptions: Array<{ id: string; label: string; rank: string }>;
  initial: DocModalValues;
  previewUrl: string | null;
  isImage: boolean;
  mode: "create" | "edit";
  saving: boolean;
  onSave: (values: DocModalValues) => void;
  onCancel: () => void;
}

/**
 * Single-document review / edit window. Left: the source file. Right: the
 * archetype's schema fields (Trident Doc-Control v9), pre-filled by AI
 * extraction or from an existing record. Used for confirming a freshly-uploaded
 * document and for editing a saved record.
 */
export function ComplianceDocModal({
  typeName,
  typeCode,
  archetype,
  archetypeFields,
  linkCardinality,
  assetOptions,
  crewOptions,
  initial,
  previewUrl,
  isImage,
  mode,
  saving,
  onSave,
  onCancel,
}: ComplianceDocModalProps) {
  const schemaFields = archetypeFields.filter((f) => f.datatype !== "fk");
  const [values, setValues] = useState<DocModalValues>(() => ({
    ...initial,
    fields: foldToSchema(
      schemaFields.map((f) => f.field),
      initial.fields,
    ),
  }));

  const linksCrew = linkCardinality === "person";
  const linksVessel = linkCardinality === "vessel";
  const canLink = !linksVessel;

  const setField = (key: string, v: string) =>
    setValues((s) => ({ ...s, fields: { ...s.fields, [key]: v } }));

  return createPortal(
    <div className="admin-panel__modal-overlay" onClick={onCancel}>
      <div
        className="admin-panel__modal compliance__ingest-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-panel__modal-header">
          <h3>
            {mode === "create" ? "Review document" : "Edit record"} —{" "}
            <span className="compliance__ingest-code">{typeCode}</span> {typeName}
          </h3>
          <button type="button" className="admin-panel__icon-btn" onClick={onCancel}>
            <XIcon />
          </button>
        </div>

        <div className="compliance__ingest-body">
          {/* LEFT — fields */}
          <div className="compliance__ingest-data">
            <div className="compliance__form-grid">
              <div className="compliance__form-section">Document</div>
              <label className="compliance__field">
                <span className="compliance__field-label">Doc number</span>
                <input
                  value={values.certNo}
                  onChange={(e) => setValues((s) => ({ ...s, certNo: e.target.value }))}
                />
              </label>
              <label className="compliance__field">
                <span className="compliance__field-label">Issuing party</span>
                <input
                  value={values.issuer}
                  onChange={(e) => setValues((s) => ({ ...s, issuer: e.target.value }))}
                />
              </label>
              <label className="compliance__field">
                <span className="compliance__field-label">Issue date</span>
                <input
                  type="date"
                  value={values.issueDate}
                  onChange={(e) => setValues((s) => ({ ...s, issueDate: e.target.value }))}
                />
              </label>
              <label className="compliance__field">
                <span className="compliance__field-label">Linked entity</span>
                {canLink ? (
                  <input
                    list={linksCrew ? "compliance-modal-crew" : "compliance-modal-assets"}
                    placeholder={linksCrew ? "crew member…" : "asset…"}
                    value={values.assetLabel}
                    onChange={(e) =>
                      setValues((s) => ({ ...s, assetLabel: e.target.value }))
                    }
                  />
                ) : (
                  <input value="This vessel" readOnly />
                )}
              </label>

              {schemaFields.length > 0 && (
                <div className="compliance__form-section">
                  {archetype ? `${archetype} details` : "Details"}
                </div>
              )}
              {schemaFields.map((f) => (
                <label
                  key={f.field}
                  className="compliance__field"
                  title={`${f.hint}${
                    f.sotRole !== "none" ? ` · ${f.sotRole} → ${f.sotTarget}` : ""
                  }`}
                >
                  <span className="compliance__field-label">
                    {prettyLabel(f.field)}
                    {f.required && <span className="compliance__req">*</span>}
                  </span>
                  {f.datatype === "bool" ? (
                    <input
                      type="checkbox"
                      checked={values.fields[f.field] === "true"}
                      onChange={(e) => setField(f.field, e.target.checked ? "true" : "")}
                    />
                  ) : (
                    <input
                      type={inputTypeFor(f.datatype)}
                      value={values.fields[f.field] ?? ""}
                      onChange={(e) => setField(f.field, e.target.value)}
                    />
                  )}
                </label>
              ))}
            </div>

            <datalist id="compliance-modal-assets">
              {assetOptions.map((a) => (
                <option key={a.id} value={a.label} />
              ))}
            </datalist>
            <datalist id="compliance-modal-crew">
              {crewOptions.map((c) => (
                <option key={c.id} value={c.label} />
              ))}
            </datalist>
          </div>

          {/* RIGHT — source preview */}
          <div className="compliance__ingest-preview">
            {previewUrl ? (
              isImage ? (
                <img src={previewUrl} alt={typeName} />
              ) : (
                <iframe
                  title={typeName}
                  src={`${previewUrl}#toolbar=0&navpanes=0&view=FitH`}
                />
              )
            ) : (
              <div className="compliance__ingest-noprev">No file preview</div>
            )}
          </div>
        </div>

        <div className="admin-panel__modal-actions">
          <button type="button" className="compliance__action-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="compliance__action-btn compliance__action-btn--primary"
            disabled={saving}
            onClick={() => onSave(values)}
          >
            {saving ? "Saving…" : mode === "create" ? "Confirm & save" : "Save changes"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
