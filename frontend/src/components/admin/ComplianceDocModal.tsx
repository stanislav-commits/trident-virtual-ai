import { useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "./AdminPanelIcons";
import { AssetMultiSelect, type AssetOption } from "./AssetMultiSelect";
import type { ArchetypeField,
  CertificateFieldSpec } from "../../api/complianceApi";
import {
  prettyLabel,
  inputTypeFor,
  foldToSchemaSplit,
} from "./compliance/complianceLabels";

export interface DocModalValues {
  certNo: string;
  issuer: string;
  issueDate: string;
  /** Crew member label (person cardinality); assets use `assetIds`. */
  assetLabel: string;
  /** Linked asset ids (M:N) for asset-cardinality documents. */
  assetIds: string[];
  fields: Record<string, string>;
}

interface ComplianceDocModalProps {
  typeName: string;
  typeCode: string;
  /** The archetype's field block from the schema. */
  archetypeFields: ArchetypeField[];
  /**
   * The document's field profile, when the catalogue defines one. It takes
   * precedence: the matrix decides per document which fields exist ("no optional
   * values"), and five of its slots — governing_standard, conditions_reference,
   * approval_authority, approval_capacity, survey_window — have no archetype
   * block at all, so a profile-blind form could not capture them.
   */
  fieldProfile?: string[] | null;
  certificateFields?: Record<string, CertificateFieldSpec>;
  nonRecordFields?: string[];
  linkCardinality: string | null;
  assetOptions: AssetOption[];
  crewOptions: Array<{ id: string; label: string; rank: string }>;
  initial: DocModalValues;
  previewUrl: string | null;
  isImage: boolean;
  mode: "create" | "edit";
  saving: boolean;
  /** Save failure — rendered inside the modal, not behind it. */
  error?: string | null;
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
  archetypeFields,
  fieldProfile,
  certificateFields,
  nonRecordFields,
  linkCardinality,
  assetOptions,
  crewOptions,
  initial,
  previewUrl,
  isImage,
  mode,
  saving,
  error,
  onSave,
  onCancel,
}: ComplianceDocModalProps) {
  const blockFields = archetypeFields.filter((f) => f.datatype !== "fk");
  // Profile first, then the archetype fields it does not name. The union is
  // deliberate: the 22 matrix columns have no slot for an archetype's own validity
  // date (EQUIP_SVC.next_due_date, PERSONNEL.earliest_expiry), and dropping
  // those would cut the value that drives expiry_date and the PMS task.
  const schemaFields: ArchetypeField[] = (() => {
    if (!fieldProfile?.length || !certificateFields) return blockFields;
    // The BASE "Document" section above already renders these three onto the
    // record's own columns; leaving them in the profile list printed each one
    // twice in the same window.
    const skip = new Set([
      ...(nonRecordFields ?? []),
      "document_number",
      "issuing_party",
      "issue_date",
      // The v9 blocks spell one of these differently — same value, one letter
      // apart from the matrix slug, and it slipped through as a duplicate input.
      "vessel_callsign",
    ]);
    const fromProfile = fieldProfile
      .filter((slug) => !skip.has(slug) && certificateFields[slug])
      .map((slug) => ({
        field: slug,
        datatype: certificateFields[slug].datatype,
        required: false,
        hint: certificateFields[slug].hint,
        sotRole: "none",
        sotTarget: "none",
        auth: false,
      }));
    const named = new Set(fromProfile.map((f) => f.field));
    return [
      ...fromProfile,
      ...blockFields.filter(
        (f) =>
          !named.has(f.field) &&
          // The v9 blocks carry their own vessel_gt / vessel_imo / call sign
          // inputs. those come from Vessel Master Data, and an editable
          // copy here would be a second source of truth for the same value.
          !skip.has(f.field),
      ),
    ];
  })();
  // `rest` holds stored values the form does not render (profile-hidden or
  // legacy keys). They ride along untouched and merge back on save — the
  // backend replaces `fields` wholesale, so leaving them out DELETES them.
  const [{ values, rest }, setState] = useState<{
    values: DocModalValues;
    rest: Record<string, string>;
  }>(() => {
    const split = foldToSchemaSplit(
      schemaFields.map((f) => f.field),
      initial.fields,
    );
    return {
      values: { ...initial, fields: split.folded },
      rest: split.rest,
    };
  });
  const setValues = (
    update: (s: DocModalValues) => DocModalValues,
  ): void => setState((s) => ({ ...s, values: update(s.values) }));

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
              {linksCrew ? (
                <label className="compliance__field">
                  <span className="compliance__field-label">Linked crew</span>
                  <input
                    list="compliance-modal-crew"
                    placeholder="crew member…"
                    value={values.assetLabel}
                    onChange={(e) =>
                      setValues((s) => ({ ...s, assetLabel: e.target.value }))
                    }
                  />
                </label>
              ) : canLink ? (
                <div className="compliance__field compliance__field--assets">
                  <span className="compliance__field-label">Linked assets</span>
                  <AssetMultiSelect
                    assets={assetOptions}
                    value={values.assetIds}
                    onChange={(ids) => setValues((s) => ({ ...s, assetIds: ids }))}
                  />
                </div>
              ) : (
                <label className="compliance__field">
                  <span className="compliance__field-label">Linked entity</span>
                  <input value="This vessel" readOnly />
                </label>
              )}

              {schemaFields.length > 0 && (
                // One heading for every document type: "The editor
                // section heading must be Certificate Details, not STAT_CERT
                // DETAILS, so the same form works for statutory, class and
                // other records."
                <div className="compliance__form-section">Certificate Details</div>
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

        {error && (
          <div className="admin-panel__error" role="alert">
            {error}
          </div>
        )}

        <div className="admin-panel__modal-actions">
          <button type="button" className="compliance__action-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="compliance__action-btn compliance__action-btn--primary"
            disabled={saving}
            onClick={() =>
              onSave({ ...values, fields: { ...rest, ...values.fields } })
            }
          >
            {saving ? "Saving…" : mode === "create" ? "Confirm & save" : "Save changes"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
