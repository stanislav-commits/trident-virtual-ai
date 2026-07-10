import { useState } from "react";
import type { ComplianceDocType } from "../../api/complianceApi";
import { StatusBadge } from "./StatusBadge";
import { prettyLabel } from "./compliance/complianceLabels";

interface ComplianceTypeRowProps {
  type: ComplianceDocType;
  assetOptions: Array<{ id: string; label: string }>;
  crewOptions: Array<{ id: string; label: string; rank: string }>;
  onAddLink: (
    docId: string,
    body: { assetId?: string; crewMemberId?: string },
  ) => void;
  onRemoveLink: (docId: string, linkId: string) => void;
  /** True while a file is uploading + extracting for this type. */
  adding: boolean;
  /** Pick a file → upload + AI-extract → open the review modal. */
  onAddDocument: () => void;
  /** Click a record → open its fields in the edit modal. */
  onEditRecord: (docId: string) => void;
  onDeleteRecord: (docId: string) => void;
  onOpenFile: (docId: string) => void;
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
  assetOptions,
  crewOptions,
  onAddLink,
  onRemoveLink,
  adding,
  onAddDocument,
  onEditRecord,
  onDeleteRecord,
  onOpenFile,
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
  const open = expanded;

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
                  <div
                    className="compliance__record compliance__record--clickable"
                    onClick={() => onEditRecord(rec.id)}
                    title="Open fields to view / edit"
                  >
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
                      {rec.issueDate ?? "?"} → {rec.expiryDate ?? "—"}
                    </span>
                    {rec.hasFile && (
                      <button
                        type="button"
                        className="compliance__record-open"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenFile(rec.id);
                        }}
                        title="Open / preview file"
                      >
                        Open
                      </button>
                    )}
                    <button
                      type="button"
                      className="compliance__record-del"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteRecord(rec.id);
                      }}
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

          {/* Action — one button: pick a file → upload + AI-extract → review */}
          <div className="compliance__detail-actions">
            <button
              type="button"
              className="compliance__action-btn compliance__action-btn--primary"
              onClick={onAddDocument}
              disabled={adding}
            >
              {adding ? "Reading document…" : "+ Add document"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
