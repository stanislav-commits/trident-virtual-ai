import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "./AdminPanelIcons";
import { CascadingSelect, type CascadeGroup } from "./CascadingSelect";
import type {
  CommitProposal,
  IngestProposal,
} from "../../api/complianceApi";

interface TypeOption {
  id: string;
  sfiCode: string;
  name: string;
  sectionCode: string;
  sectionName: string;
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
  fileUrl: string | null;
  isPdf: boolean;
  isImage: boolean;
}

const prettyKey = (k: string) =>
  k
    .replace(/_id$/, "")
    .replace(/[._]/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

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
  assetOptions,
  busy,
  onCancel,
  onConfirm,
}: {
  proposals: IngestProposal[];
  files: File[];
  types: TypeOption[];
  assetOptions: Array<{ id: string; label: string }>;
  busy: boolean;
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
        fields,
        assetLabel: assetOptions.find((a) => a.id === p.assetId)?.label ?? "",
        confidence: p.confidence,
        message: p.message,
        include: p.status === "matched",
        fileUrl: urls[i] ?? null,
        isPdf: (file?.type ?? "").includes("pdf"),
        isImage: (file?.type ?? "").startsWith("image/"),
      };
    }),
  );
  const [sel, setSel] = useState(0);
  const row = rows[sel];

  const patch = (next: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === sel ? { ...r, ...next } : r)));
  const setInclude = (i: number, v: boolean) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, include: v } : r)));

  const includedCount = rows.filter((r) => r.include && r.typeId).length;

  const confirm = () => {
    const out: CommitProposal[] = rows
      .filter((r) => r.include && r.typeId)
      .map((r) => ({
        typeId: r.typeId as string,
        certNo: r.certNo || null,
        issuer: r.issuer || null,
        issueDate: r.issueDate || null,
        assetId: assetOptions.find((a) => a.label === r.assetLabel)?.id ?? null,
        fields: Object.fromEntries(
          Object.entries(r.fields).filter(([, v]) => v !== ""),
        ),
      }));
    onConfirm(out);
  };

  return createPortal(
    <div className="admin-panel__modal-overlay" onClick={onCancel}>
      <div
        className="admin-panel__modal compliance__ingest-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-panel__modal-header">
          <h3>
            Review {proposals.length} document{proposals.length === 1 ? "" : "s"}
          </h3>
          <button type="button" className="admin-panel__icon-btn" onClick={onCancel}>
            <XIcon />
          </button>
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
                    onChange={(id) => patch({ typeId: id })}
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
                  {Object.keys(row.fields).map((key) => (
                    <label key={key} className="compliance__field">
                      <span className="compliance__field-label">{prettyKey(key)}</span>
                      <input
                        value={row.fields[key]}
                        onChange={(e) =>
                          patch({ fields: { ...row.fields, [key]: e.target.value } })
                        }
                      />
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* RIGHT — large preview */}
          <div className="compliance__ingest-preview">
            {row?.isPdf && row.fileUrl ? (
              <iframe
                title={row.filename}
                src={`${row.fileUrl}#toolbar=0&navpanes=0&view=FitH`}
              />
            ) : row?.isImage && row.fileUrl ? (
              <img src={row.fileUrl} alt={row.filename} />
            ) : (
              <div className="compliance__ingest-noprev">
                No preview for {row?.filename}
              </div>
            )}
          </div>
        </div>

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
