import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { CascadingSelect, type CascadeGroup } from "./CascadingSelect";
import {
  prettyLabel,
  inputTypeFor,
  foldToSchema,
} from "./compliance/complianceLabels";
import type {
  ArchetypeField,
  ArchetypeSchema,
  CommitProposal,
  IngestProposal,
} from "../../api/complianceApi";

interface TypeOption {
  id: string;
  sfiCode: string;
  name: string;
  sectionCode: string;
  sectionName: string;
  archetype: string | null;
}

/** doc_number / issuing_party / issue_date have dedicated base inputs. */
const BASE_FIELD_KEYS = ["doc_number", "issuing_party", "issue_date"];

/**
 * Archetype field block for a type — this is what makes the form follow the
 * type picker instead of freezing on whatever field keys the AI proposal
 * happened to carry.
 */
function archetypeFieldsFor(
  schema: ArchetypeSchema | null,
  typeById: Map<string, TypeOption>,
  typeId: string | null,
): ArchetypeField[] {
  const archetype = typeId ? typeById.get(typeId)?.archetype : null;
  if (!archetype || !schema) return [];
  return (schema.archetypes[archetype] ?? []).filter(
    (f) => f.datatype !== "fk" && !BASE_FIELD_KEYS.includes(f.field),
  );
}

/**
 * Fold raw extracted/edited values onto the given type's schema keys
 * (compound keys gathered from their parts). Done once per type change, not
 * per render, so clearing a folded field stays cleared.
 */
function foldForType(
  schema: ArchetypeSchema | null,
  typeById: Map<string, TypeOption>,
  typeId: string | null,
  fields: Record<string, string>,
): Record<string, string> {
  const keys = archetypeFieldsFor(schema, typeById, typeId).map((f) => f.field);
  return keys.length ? { ...fields, ...foldToSchema(keys, fields) } : fields;
}

interface Row {
  filename: string;
  status: IngestProposal["status"];
  typeId: string | null;
  certNo: string;
  issuer: string;
  issueDate: string;
  fields: Record<string, string>;
  assetLabel: string;
  confidence?: number;
  message?: string;
  include: boolean;
  isPdf: boolean;
  isImage: boolean;
  extractedText?: string;
}

/** A field is a date if its key implies one or its value is an ISO date. */
const isDateField = (key: string, value: string) =>
  /(date|expiry|_from|_to|anniversary|cover_|term_|renewal)/i.test(key) ||
  /^\d{4}-\d{2}-\d{2}/.test(value ?? "");

/**
 * Batch upload review window. Left: the file list + the selected file's
 * proposed type (category → document, searchable) and editable fields.
 * Right: a large preview of the selected document. Nothing is saved until
 * "Confirm".
 */
export function ComplianceIngestModal({
  proposals,
  files,
  types,
  schema,
  assetOptions,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  proposals: IngestProposal[];
  files: File[];
  types: TypeOption[];
  schema: ArchetypeSchema | null;
  assetOptions: Array<{ id: string; label: string }>;
  busy: boolean;
  /** Commit failure — rendered inside the modal (a page banner would be hidden behind the overlay). */
  error?: string | null;
  onCancel: () => void;
  onConfirm: (proposals: CommitProposal[]) => void;
}) {
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);

  // Types grouped by SFI section for the cascading picker.
  const typeGroups = useMemo<CascadeGroup[]>(() => {
    const bySection = new Map<string, CascadeGroup>();
    for (const t of types) {
      let g = bySection.get(t.sectionCode);
      if (!g) {
        g = {
          key: t.sectionCode,
          label: `${t.sectionCode} ${t.sectionName}`,
          items: [],
        };
        bySection.set(t.sectionCode, g);
      }
      g.items.push({ id: t.id, label: t.name, sub: t.sfiCode });
    }
    return [...bySection.values()];
  }, [types]);

  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);

  const [rows, setRows] = useState<Row[]>(() =>
    proposals.map((p, i) => {
      const file = files[i];
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.fields ?? {}))
        fields[k] = v == null ? "" : String(v);
      return {
        filename: p.filename,
        status: p.status,
        typeId: p.typeId ?? null,
        certNo: p.certNo ?? "",
        issuer: p.issuer ?? "",
        issueDate: p.issueDate ?? "",
        fields: foldForType(schema, typeById, p.typeId ?? null, fields),
        assetLabel: assetOptions.find((a) => a.id === p.assetId)?.label ?? "",
        confidence: p.confidence,
        message: p.message,
        include: p.status === "matched",
        isPdf: (file?.type ?? "").includes("pdf"),
        isImage: (file?.type ?? "").startsWith("image/"),
        extractedText: p.extractedText,
      };
    }),
  );
  const [sel, setSel] = useState(0);
  const row = rows[sel];
  const previewUrl = urls[sel] ?? null;

  // The schema is fetched independently of the modal — if it resolves after
  // mount, re-fold the rows so pre-matched proposals get their extracted
  // values onto the archetype keys. Folding is idempotent (exact keys win),
  // so running again on an already-folded row is a no-op.
  useEffect(() => {
    if (!schema) return;
    setRows((rs) =>
      rs.map((r) => ({
        ...r,
        fields: foldForType(schema, typeById, r.typeId, r.fields),
      })),
    );
  }, [schema, typeById]);

  const patch = (next: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === sel ? { ...r, ...next } : r)));
  const setInclude = (i: number, v: boolean) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, include: v } : r)));

  const includedCount = rows.filter((r) => r.include && r.typeId).length;

  const schemaFieldsFor = (typeId: string | null): ArchetypeField[] =>
    archetypeFieldsFor(schema, typeById, typeId);

  /** Non-empty fields to save: the schema's keys when known, else all raw. */
  const pickFields = (r: Row): Record<string, string> => {
    const schemaKeys = schemaFieldsFor(r.typeId).map((f) => f.field);
    const entries = schemaKeys.length
      ? schemaKeys.map((k) => [k, r.fields[k] ?? ""] as const)
      : Object.entries(r.fields);
    return Object.fromEntries(entries.filter(([, v]) => v !== ""));
  };

  const confirm = () => {
    const out: CommitProposal[] = rows
      .filter((r) => r.include && r.typeId)
      .map((r) => ({
        typeId: r.typeId as string,
        filename: r.filename,
        certNo: r.certNo || null,
        issuer: r.issuer || null,
        issueDate: r.issueDate || null,
        assetId: assetOptions.find((a) => a.label === r.assetLabel)?.id ?? null,
        // Save the confirmed type's schema fields, not whatever keys the AI
        // proposal carried (they belong to the originally guessed type).
        fields: pickFields(r),
        extractedText: r.extractedText,
      }));
    onConfirm(out);
  };

  return createPortal(
    // No overlay-click / X close: the operator may have half-filled fields,
    // and a stray click outside must not throw them away. Cancel only.
    <div className="admin-panel__modal-overlay">
      <div className="admin-panel__modal compliance__ingest-modal">
        <div className="admin-panel__modal-header">
          <h3>
            Review {proposals.length} document{proposals.length === 1 ? "" : "s"}
          </h3>
        </div>

        <div className="compliance__ingest-body">
          {/* LEFT — data side */}
          <div className="compliance__ingest-data">
            {/* file picker */}
            <div className="compliance__ingest-files">
              {rows.map((r, i) => (
                <button
                  key={i}
                  type="button"
                  className={`compliance__ingest-file-btn${i === sel ? " compliance__ingest-file-btn--on" : ""}`}
                  onClick={() => setSel(i)}
                >
                  <input
                    type="checkbox"
                    checked={r.include}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setInclude(i, e.target.checked)}
                  />
                  <span className="compliance__ingest-file-name">{r.filename}</span>
                  {r.status !== "matched" && (
                    <span className="compliance__ingest-dot" title={r.message} />
                  )}
                </button>
              ))}
            </div>

            {row && (
              <div className="compliance__ingest-form">
                {row.status !== "matched" && (
                  <div className="compliance__ingest-warn">
                    {row.message ?? "Pick a type manually."}
                  </div>
                )}

                {/* category → document, searchable (one field) */}
                <label className="compliance__field">
                  <span className="compliance__field-label">Document type</span>
                  <CascadingSelect
                    value={row.typeId}
                    groups={typeGroups}
                    placeholder="Choose category → document"
                    onChange={(id) =>
                      // Re-fold the extracted values onto the new type's
                      // archetype fields so the form follows the picker.
                      patch({
                        typeId: id,
                        fields: foldForType(schema, typeById, id, row.fields),
                      })
                    }
                  />
                </label>

                <div className="compliance__ingest-grid">
                  <label className="compliance__field">
                    <span className="compliance__field-label">Doc number</span>
                    <input
                      value={row.certNo}
                      onChange={(e) => patch({ certNo: e.target.value })}
                    />
                  </label>
                  <label className="compliance__field">
                    <span className="compliance__field-label">Issuing party</span>
                    <input
                      value={row.issuer}
                      onChange={(e) => patch({ issuer: e.target.value })}
                    />
                  </label>
                  <label className="compliance__field">
                    <span className="compliance__field-label">Issue date</span>
                    <input
                      type="date"
                      value={row.issueDate}
                      onChange={(e) => patch({ issueDate: e.target.value })}
                    />
                  </label>
                  <label className="compliance__field">
                    <span className="compliance__field-label">Linked asset</span>
                    <input
                      list="compliance-assets"
                      value={row.assetLabel}
                      placeholder="optional…"
                      onChange={(e) => patch({ assetLabel: e.target.value })}
                    />
                  </label>
                  {schemaFieldsFor(row.typeId).length > 0
                    ? // Schema-driven: the selected type's archetype decides the
                      // field set; extracted values were folded onto it when the
                      // type was chosen.
                      schemaFieldsFor(row.typeId).map((f) => (
                        <label
                          key={f.field}
                          className="compliance__field"
                          title={f.hint}
                        >
                          <span className="compliance__field-label">
                            {prettyLabel(f.field)}
                            {f.required && <span className="compliance__req">*</span>}
                          </span>
                          {f.datatype === "bool" ? (
                            <input
                              type="checkbox"
                              checked={row.fields[f.field] === "true"}
                              onChange={(e) =>
                                patch({
                                  fields: {
                                    ...row.fields,
                                    [f.field]: e.target.checked ? "true" : "",
                                  },
                                })
                              }
                            />
                          ) : (
                            <input
                              type={inputTypeFor(f.datatype)}
                              value={row.fields[f.field] ?? ""}
                              onChange={(e) =>
                                patch({
                                  fields: { ...row.fields, [f.field]: e.target.value },
                                })
                              }
                            />
                          )}
                        </label>
                      ))
                    : // No archetype schema for this type — fall back to the raw
                      // proposal field keys.
                      Object.keys(row.fields)
                        // doc_number / issuing_party / issue_date already have
                        // their own base inputs above — don't render them again.
                        .filter((key) => !BASE_FIELD_KEYS.includes(key))
                        .map((key) => (
                          <label key={key} className="compliance__field">
                            <span className="compliance__field-label">
                              {prettyLabel(key)}
                            </span>
                            <input
                              type={isDateField(key, row.fields[key]) ? "date" : "text"}
                              value={row.fields[key]}
                              onChange={(e) =>
                                patch({
                                  fields: { ...row.fields, [key]: e.target.value },
                                })
                              }
                            />
                          </label>
                        ))}
                </div>
              </div>
            )}
          </div>

          {/* RIGHT — large preview. Read the URL from the live `urls` memo, NOT
              from row state: the row keeps a stale blob URL that the cleanup
              effect has already revoked (React StrictMode re-mount), which the
              browser then reports as "moved / deleted". */}
          <div className="compliance__ingest-preview">
            {previewUrl && row?.isPdf ? (
              <iframe
                title={row.filename}
                src={`${previewUrl}#toolbar=0&navpanes=0&view=FitH`}
              />
            ) : previewUrl && row?.isImage ? (
              <img src={previewUrl} alt={row.filename} />
            ) : (
              <div className="compliance__ingest-noprev">
                No preview for {row?.filename}
              </div>
            )}
          </div>
        </div>

        {error && (
          <div className="admin-panel__error" role="alert">
            {error}
          </div>
        )}

        <div className="admin-panel__modal-actions">
          <button
            type="button"
            className="compliance__action-btn"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="compliance__action-btn compliance__action-btn--primary"
            onClick={confirm}
            disabled={busy || includedCount === 0}
          >
            {busy
              ? "Saving…"
              : `Confirm ${includedCount} document${includedCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
