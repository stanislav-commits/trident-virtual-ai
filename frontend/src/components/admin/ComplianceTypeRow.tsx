import { useState } from "react";
import type {
  ArchetypeField,
  ComplianceDocType,
} from "../../api/complianceApi";
import { StatusBadge } from "./StatusBadge";

/** Manual-record form draft. State lives in ComplianceSection (one shared
 *  draft — only one type is in edit mode at a time). */
export interface ComplianceRecordFormState {
  certNo: string;
  issuer: string;
  issueDate: string;
  expiryDate: string;
  assetLabel: string;
  /** Archetype-specific captured field values (→ compliance_docs.fields). */
  fields: Record<string, string>;
}

const inputTypeFor = (datatype: string): string =>
  datatype === "date"
    ? "date"
    : datatype === "int" || datatype === "number"
      ? "number"
      : "text";

const ACRONYMS = new Set([
  "id", "imo", "gt", "hru", "coc", "stcw", "gmdss", "ecdis", "sea", "nc",
  "poa", "kyc", "vat", "mlc", "ism", "isps", "sdr", "nox",
]);

/** Backend keeps snake_case field keys; the UI shows a human label. */
function prettyLabel(field: string): string {
  const cleaned = field.replace(/_id$/, "").replace(/[._]/g, " ");
  const out = cleaned
    .split(" ")
    .map((w) =>
      w
        .split("/")
        .map((p) => (ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : p))
        .join("/"),
    )
    .join(" ");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

interface ComplianceTypeRowProps {
  type: ComplianceDocType;
  /** True when this type's manual-record form is open. */
  editing: boolean;
  form: ComplianceRecordFormState;
  onFormChange: (patch: Partial<ComplianceRecordFormState>) => void;
  /** The archetype's field block (drives the dynamic inputs). */
  archetypeFields: ArchetypeField[];
  assetOptions: Array<{ id: string; label: string }>;
  crewOptions: Array<{ id: string; label: string; rank: string }>;
  onAddLink: (
    docId: string,
    body: { assetId?: string; crewMemberId?: string },
  ) => void;
  onRemoveLink: (docId: string, linkId: string) => void;
  saving: boolean;
  uploading: boolean;
  onStartUpload: () => void;
  onStartAdd: () => void;
  onSubmit: () => void;
  onCancelEdit: () => void;
  onDeleteRecord: (docId: string) => void;
  onUpdateExpiry: (docId: string, expiryDate: string) => void;
}

/** Inline "link another asset / crew" picker — module-level to keep focus. */
function LinkAdder({
  listId,
  options,
  placeholder,
  onPick,
}: {
  listId: string;
  options: Array<{ id: string; label: string }>;
  placeholder: string;
  onPick: (id: string) => void;
}) {
  const [val, setVal] = useState("");
  const commit = () => {
    const match = options.find((o) => o.label === val);
    if (match) {
      onPick(match.id);
      setVal("");
    }
  };
  return (
    <span className="compliance__link-add">
      <input
        list={listId}
        value={val}
        placeholder={placeholder}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <button type="button" onClick={commit} disabled={!val}>
        + link
      </button>
    </span>
  );
}

/**
 * One document type inside the selected compliance section. The header row
 * (code · name · archetype · status) is a toggle: click the name to expand a
 * detail panel with the document's basis, its records, and the add / upload
 * actions. The manual-record form renders as a labelled grid.
 *
 * Declared at MODULE level on purpose — it renders form inputs, and a
 * component type recreated inside a render function would remount them and
 * drop focus on every keystroke.
 */
export function ComplianceTypeRow({
  type,
  editing,
  form,
  onFormChange,
  archetypeFields,
  assetOptions,
  crewOptions,
  onAddLink,
  onRemoveLink,
  saving,
  uploading,
  onStartUpload,
  onStartAdd,
  onSubmit,
  onCancelEdit,
  onDeleteRecord,
  onUpdateExpiry,
}: ComplianceTypeRowProps) {
  // What a document links to follows its cardinality (schema v9):
  //   person → crew; single_asset/per_unit/sub_group → assets; vessel → nothing.
  const cardinality = type.linkCardinality;
  const linksCrew = cardinality === "person";
  const linksAsset =
    cardinality === "single_asset" ||
    cardinality === "per_unit" ||
    cardinality === "sub_group";
  const canLink = linksCrew || linksAsset;
  const [expanded, setExpanded] = useState(false);
  const open = expanded || editing;

  const setField = (name: string, value: string) =>
    onFormChange({ fields: { ...form.fields, [name]: value } });

  // Picking the crew member auto-fills `rank` from the roster (read-only).
  const onLinkChange = (val: string) => {
    if (linksCrew) {
      const c = crewOptions.find((o) => o.label === val);
      onFormChange({
        assetLabel: val,
        fields: c ? { ...form.fields, rank: c.rank } : form.fields,
      });
    } else {
      onFormChange({ assetLabel: val });
    }
  };

  // Asset/person cardinalities require the link; vessel docs don't.
  const linkRequired = canLink;

  const recordCount = type.records.length;

  return (
    <div className={`compliance__type${open ? " compliance__type--open" : ""}`}>
      <div className="compliance__type-row">
        <span className="compliance__type-code">{type.sfiCode}</span>
        <button
          type="button"
          className="compliance__type-name-btn"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={open}
        >
          <span className="compliance__chevron">{open ? "▾" : "▸"}</span>
          <span className="compliance__type-name">{type.name}</span>
          {type.applicability === "C" && (
            <span className="compliance__cond" title="Conditional">
              C
            </span>
          )}
        </button>
        {type.archetype && (
          <span
            className="compliance__archetype"
            title={[
              `Archetype: ${type.archetype}`,
              type.linkCardinality && `Link: ${type.linkCardinality}`,
              type.drivesPms &&
                type.drivesPms !== "no" &&
                `Drives PMS: ${type.drivesPms}`,
            ]
              .filter(Boolean)
              .join("\n")}
          >
            {type.archetype}
          </span>
        )}
        {recordCount > 0 && (
          <span className="compliance__rec-count" title="Records on file">
            {recordCount}
          </span>
        )}
        {type.status && (
          <StatusBadge base="compliance__badge" variant={type.status}>
            {type.status.toUpperCase()}
          </StatusBadge>
        )}
      </div>

      {open && (
        <div className="compliance__detail">
          {/* What this document is + how it behaves */}
          {(type.basisNote ||
            type.regBasis ||
            type.linkCardinality ||
            (type.drivesPms && type.drivesPms !== "no")) && (
            <div className="compliance__detail-info">
              {type.basisNote && (
                <p className="compliance__detail-note">{type.basisNote}</p>
              )}
              <div className="compliance__detail-tags">
                {type.regBasis && (
                  <span title="Regulatory basis">Basis: {type.regBasis}</span>
                )}
                {type.linkCardinality && (
                  <span title="How it links to assets">
                    Link: {prettyLabel(type.linkCardinality)}
                  </span>
                )}
                {type.drivesPms && type.drivesPms !== "no" && (
                  <span title="Drives a PMS task">PMS: {type.drivesPms}</span>
                )}
                {type.renewalCycle && <span>Renews: {type.renewalCycle}</span>}
              </div>
            </div>
          )}

          {/* Existing records */}
          {recordCount > 0 && (
            <div className="compliance__records">
              {type.records.map((rec) => (
                <div key={rec.id} className="compliance__record-wrap">
                  <div className="compliance__record">
                    <StatusBadge base="compliance__badge" variant={rec.status}>
                      {rec.status.toUpperCase()}
                    </StatusBadge>
                    <span className="compliance__record-main">
                      {rec.documentFileName ?? rec.certNo ?? "—"}
                      {rec.issuer ? ` · ${rec.issuer}` : ""}
                      {rec.verifyState === "auto" && (
                        <span className="compliance__verify" title="AI-extracted — confirm">
                          auto
                        </span>
                      )}
                    </span>
                    <span className="compliance__record-dates">
                      {rec.issueDate ?? "?"} →{" "}
                      <input
                        type="date"
                        className="compliance__record-expiry"
                        value={rec.expiryDate ?? ""}
                        onChange={(e) => onUpdateExpiry(rec.id, e.target.value)}
                        title="Expiry / next due — edit to update"
                      />
                    </span>
                    <button
                      type="button"
                      className="compliance__record-del"
                      onClick={() => onDeleteRecord(rec.id)}
                      title="Delete record"
                    >
                      ×
                    </button>
                  </div>
                  {/* Identity mismatch vs the register (register wins) */}
                  {rec.identityFlags && rec.identityFlags.length > 0 && (
                    <div className="compliance__mismatch">
                      Register mismatch —{" "}
                      {rec.identityFlags
                        .map(
                          (m) =>
                            `${prettyLabel(m.field)}: doc "${m.documentValue}" vs register "${m.registerValue}"`,
                        )
                        .join("; ")}
                    </div>
                  )}
                  {/* Linked assets / crew (Link_Model) */}
                  {(canLink || (rec.links?.length ?? 0) > 0) && (
                    <div className="compliance__links">
                      {(rec.links ?? []).map((l) => (
                        <span
                          key={l.id}
                          className="compliance__link-chip"
                          title={`${l.linkRole}${
                            l.verifyState === "auto" ? " · auto" : ""
                          }`}
                        >
                          {l.assetName ?? l.crewName ?? "—"}
                          <button
                            type="button"
                            className="compliance__link-del"
                            onClick={() => onRemoveLink(rec.id, l.id)}
                            title="Unlink"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      {canLink && (
                        <LinkAdder
                          listId={
                            linksCrew ? "compliance-crew" : "compliance-assets"
                          }
                          options={linksCrew ? crewOptions : assetOptions}
                          placeholder={linksCrew ? "link crew…" : "link asset…"}
                          onPick={(id) =>
                            onAddLink(
                              rec.id,
                              linksCrew
                                ? { crewMemberId: id }
                                : { assetId: id },
                            )
                          }
                        />
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Actions / form */}
          {!editing ? (
            <div className="compliance__detail-actions">
              <button
                type="button"
                className="compliance__action-btn compliance__action-btn--primary"
                onClick={onStartAdd}
              >
                + Add record
              </button>
              <button
                type="button"
                className="compliance__action-btn"
                onClick={onStartUpload}
                disabled={uploading}
              >
                {uploading ? "Uploading…" : "Upload PDF"}
              </button>
            </div>
          ) : (
            <div className="compliance__form-grid">
              {/* BASE block — the same 5 fields on every document */}
              <div className="compliance__form-section">Document</div>
              <label className="compliance__field">
                <span className="compliance__field-label">Doc number</span>
                <input
                  value={form.certNo}
                  onChange={(e) => onFormChange({ certNo: e.target.value })}
                />
              </label>
              <label className="compliance__field">
                <span className="compliance__field-label">Issuing party</span>
                <input
                  value={form.issuer}
                  onChange={(e) => onFormChange({ issuer: e.target.value })}
                />
              </label>
              <label className="compliance__field">
                <span className="compliance__field-label">Issue date</span>
                <input
                  type="date"
                  value={form.issueDate}
                  onChange={(e) => onFormChange({ issueDate: e.target.value })}
                />
              </label>
              <label className="compliance__field">
                <span className="compliance__field-label">
                  Linked entity
                  {linkRequired && <span className="compliance__req">*</span>}
                </span>
                {canLink ? (
                  <input
                    list={linksCrew ? "compliance-crew" : "compliance-assets"}
                    placeholder={linksCrew ? "crew member…" : "asset…"}
                    value={form.assetLabel}
                    onChange={(e) => onLinkChange(e.target.value)}
                  />
                ) : (
                  <input value="This vessel" readOnly />
                )}
              </label>
              <label className="compliance__field">
                <span className="compliance__field-label">
                  Status
                  <span className="compliance__auto-tag">auto</span>
                </span>
                <input
                  value="derived from validity"
                  readOnly
                  title="Computed from the validity date — valid / expiring / expired"
                />
              </label>

              {/* Archetype-specific fields (the regulation's field set) */}
              <div className="compliance__form-section">
                {type.archetype ? `${type.archetype} details` : "Details"}
              </div>

              {archetypeFields
                .filter((f) => f.datatype !== "fk")
                .map((f) => {
                  // rank is derived from the linked crew member, not typed.
                  const autoRank = linksCrew && f.field === "rank";
                  return (
                    <label
                      key={f.field}
                      className="compliance__field"
                      title={`${f.hint}${
                        f.sotRole !== "none"
                          ? ` · ${f.sotRole} → ${f.sotTarget}`
                          : ""
                      }`}
                    >
                      <span className="compliance__field-label">
                        {prettyLabel(f.field)}
                        {f.required && <span className="compliance__req">*</span>}
                        {autoRank && (
                          <span className="compliance__auto-tag">auto</span>
                        )}
                      </span>
                      {f.datatype === "bool" ? (
                        <input
                          type="checkbox"
                          checked={form.fields[f.field] === "true"}
                          onChange={(e) =>
                            setField(f.field, e.target.checked ? "true" : "")
                          }
                        />
                      ) : (
                        <input
                          type={inputTypeFor(f.datatype)}
                          value={form.fields[f.field] ?? ""}
                          placeholder={
                            autoRank
                              ? "from crew member"
                              : f.datatype === "date"
                                ? ""
                                : f.hint
                          }
                          readOnly={autoRank}
                          onChange={(e) => setField(f.field, e.target.value)}
                        />
                      )}
                    </label>
                  );
                })}

              <div className="compliance__form-actions">
                <button
                  type="button"
                  className="compliance__action-btn"
                  onClick={onCancelEdit}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="compliance__action-btn compliance__action-btn--primary"
                  disabled={saving}
                  onClick={onSubmit}
                >
                  {saving ? "Saving…" : "Save record"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
