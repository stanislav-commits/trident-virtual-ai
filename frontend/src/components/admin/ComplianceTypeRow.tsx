import type { ComplianceDocType } from "../../api/complianceApi";
import { StatusBadge } from "./StatusBadge";

/** Manual-record form draft. State lives in ComplianceSection (one shared
 *  draft — only one type is in edit mode at a time). */
export interface ComplianceRecordFormState {
  certNo: string;
  issuer: string;
  issueDate: string;
  expiryDate: string;
  assetLabel: string;
}

interface ComplianceTypeRowProps {
  type: ComplianceDocType;
  /** True when this type's manual-record form is open. */
  editing: boolean;
  form: ComplianceRecordFormState;
  onFormChange: (patch: Partial<ComplianceRecordFormState>) => void;
  saving: boolean;
  uploading: boolean;
  onStartUpload: () => void;
  onStartAdd: () => void;
  onSubmit: () => void;
  onCancelEdit: () => void;
  onDeleteRecord: (docId: string) => void;
  onUpdateExpiry: (docId: string, expiryDate: string) => void;
}

/**
 * One document type inside the selected compliance section: header row
 * (code · name · status badge · upload / add buttons), the inline manual
 * record form when editing, and the existing records underneath.
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
  saving,
  uploading,
  onStartUpload,
  onStartAdd,
  onSubmit,
  onCancelEdit,
  onDeleteRecord,
  onUpdateExpiry,
}: ComplianceTypeRowProps) {
  return (
    <div className="compliance__type">
      <div className="compliance__type-row">
        <span className="compliance__type-code">{type.sfiCode}</span>
        <span
          className="compliance__type-name"
          title={[
            type.renewalCycle && `Cycle: ${type.renewalCycle}`,
            type.surveyWindow && `Window: ${type.surveyWindow}`,
            type.updateTrigger && `Trigger: ${type.updateTrigger}`,
            type.notes && `Notes: ${type.notes}`,
          ]
            .filter(Boolean)
            .join("\n")}
        >
          {type.name}
          {type.applicability === "C" && (
            <span className="compliance__cond" title="Conditional">
              C
            </span>
          )}
        </span>
        {type.status && (
          <StatusBadge base="compliance__badge" variant={type.status}>
            {type.status.toUpperCase()}
          </StatusBadge>
        )}
        <button
          type="button"
          className="compliance__upload-btn"
          onClick={onStartUpload}
          disabled={uploading}
          title="Upload the certificate PDF for this type"
        >
          {uploading ? "…" : "⬆ Upload"}
        </button>
        <button
          type="button"
          className="compliance__add-btn"
          onClick={onStartAdd}
          title="Record manually (no file)"
        >
          +
        </button>
      </div>
      <div className="compliance__type-meta">
        {type.renewalCycle}
        {type.surveyWindow ? ` · ${type.surveyWindow}` : ""}
      </div>

      {editing && (
        <div className="compliance__form">
          <input
            placeholder="Cert / Doc №"
            value={form.certNo}
            onChange={(e) => onFormChange({ certNo: e.target.value })}
          />
          <input
            placeholder="Issuer"
            value={form.issuer}
            onChange={(e) => onFormChange({ issuer: e.target.value })}
          />
          <input
            type="date"
            title="Issue date"
            value={form.issueDate}
            onChange={(e) => onFormChange({ issueDate: e.target.value })}
          />
          <input
            type="date"
            title="Expiry / next due"
            value={form.expiryDate}
            onChange={(e) => onFormChange({ expiryDate: e.target.value })}
          />
          <input
            className="compliance__asset-input"
            list="compliance-assets"
            placeholder="Link asset (type to search)"
            value={form.assetLabel}
            onChange={(e) => onFormChange({ assetLabel: e.target.value })}
          />
          <button type="button" disabled={saving} onClick={onSubmit}>
            {saving ? "…" : "Save"}
          </button>
          <button type="button" onClick={onCancelEdit}>
            Cancel
          </button>
        </div>
      )}

      {type.records.map((rec) => (
        <div key={rec.id} className="compliance__record">
          <StatusBadge base="compliance__badge" variant={rec.status}>
            {rec.status.toUpperCase()}
          </StatusBadge>
          <span className="compliance__record-main">
            {rec.documentFileName
              ? `📄 ${rec.documentFileName}`
              : (rec.certNo ?? "—")}
            {rec.issuer ? ` · ${rec.issuer}` : ""}
            {rec.assetName ? ` · ${rec.assetName}` : ""}
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
      ))}
    </div>
  );
}
