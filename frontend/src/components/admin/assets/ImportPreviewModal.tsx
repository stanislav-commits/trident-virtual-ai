import { useState } from "react";
import {
  commitImportAssetsXlsx,
  type CommitImportResult,
  type ImportPreviewResult,
} from "../../../api/assetsApi";

interface ImportPreviewModalProps {
  token: string;
  shipId: string;
  file: File;
  preview: ImportPreviewResult;
  onClose: () => void;
  onApplied: (result: CommitImportResult) => void;
}

/**
 * Preview-and-confirm modal shown after the user drops an xlsx file.
 * Shows counts + collapsible sample lists for create / update / orphans
 * / potential renames. Admin ticks deleteOrphans + mergeRenames before
 * the actual commit fires.
 *
 * snapshotBefore is forced true (admin-protective default). The toggle
 * is shown so the admin sees we're snapshotting — but it's only
 * uncheckable for "I really know what I'm doing" cases.
 */
export function ImportPreviewModal({
  token,
  shipId,
  file,
  preview,
  onClose,
  onApplied,
}: ImportPreviewModalProps) {
  const [deleteOrphans, setDeleteOrphans] = useState(false);
  const [mergeRenames, setMergeRenames] = useState(true);
  const [snapshotBefore, setSnapshotBefore] = useState(true);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState<
    "create" | "update" | "orphans" | "renames" | "errors" | "sfi" | null
  >(null);

  const handleApply = async () => {
    setCommitting(true);
    setError("");
    try {
      const result = await commitImportAssetsXlsx(token, shipId, file, {
        deleteOrphans,
        mergeRenames,
        snapshotBefore,
      });
      onApplied(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit failed");
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="import-preview" role="dialog" aria-label="Import preview">
      <div className="import-preview__backdrop" onClick={onClose} />
      <div className="import-preview__sheet">
        <div className="import-preview__head">
          <div>
            <h3 className="import-preview__title">Import preview</h3>
            <div className="import-preview__file">{file.name}</div>
          </div>
          <button
            type="button"
            className="import-preview__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="import-preview__stats">
          <StatPill
            label="Create"
            count={preview.counts.create}
            tone="green"
            onClick={() => setExpanded(expanded === "create" ? null : "create")}
            active={expanded === "create"}
          />
          <StatPill
            label="Update"
            count={preview.counts.update}
            tone="blue"
            onClick={() => setExpanded(expanded === "update" ? null : "update")}
            active={expanded === "update"}
          />
          <StatPill
            label="Orphans (in DB, not in file)"
            count={preview.counts.orphans}
            tone="amber"
            onClick={() =>
              setExpanded(expanded === "orphans" ? null : "orphans")
            }
            active={expanded === "orphans"}
          />
          <StatPill
            label="Possible renames"
            count={preview.counts.renames}
            tone="purple"
            onClick={() =>
              setExpanded(expanded === "renames" ? null : "renames")
            }
            active={expanded === "renames"}
          />
          {preview.counts.parseErrors > 0 && (
            <StatPill
              label="Parse errors"
              count={preview.counts.parseErrors}
              tone="red"
              onClick={() =>
                setExpanded(expanded === "errors" ? null : "errors")
              }
              active={expanded === "errors"}
            />
          )}
          {preview.counts.sfiWarnings > 0 && (
            <StatPill
              label="SFI issues (off-standard codes)"
              count={preview.counts.sfiWarnings}
              tone="amber"
              onClick={() => setExpanded(expanded === "sfi" ? null : "sfi")}
              active={expanded === "sfi"}
            />
          )}
        </div>

        <div className="import-preview__list">
          {expanded === "create" &&
            preview.create.slice(0, 100).map((c) => (
              <div key={c.assetIdInternal} className="import-preview__row">
                <span className="import-preview__code">{c.assetIdInternal}</span>
                <span className="import-preview__name">{c.displayName}</span>
                <span className="import-preview__meta">
                  {c.brand ?? "—"} · {c.model ?? "—"}
                </span>
              </div>
            ))}
          {expanded === "update" &&
            preview.update.slice(0, 100).map((u) => (
              <div key={u.assetIdInternal} className="import-preview__row">
                <span className="import-preview__code">{u.assetIdInternal}</span>
                <span className="import-preview__name">{u.displayName}</span>
                <span className="import-preview__meta">
                  {u.changes
                    .slice(0, 4)
                    .map((c) => `${c.field}: "${c.oldValue ?? "∅"}" → "${c.newValue ?? "∅"}"`)
                    .join(" · ")}
                  {u.changes.length > 4 && ` (+${u.changes.length - 4} more)`}
                </span>
              </div>
            ))}
          {expanded === "orphans" &&
            preview.orphans.slice(0, 100).map((o) => (
              <div key={o.assetIdInternal} className="import-preview__row">
                <span className="import-preview__code">{o.assetIdInternal}</span>
                <span className="import-preview__name">{o.displayName}</span>
                <span className="import-preview__meta">
                  {o.brand ?? "—"} · {o.model ?? "—"} ·{" "}
                  metrics={o.boundMetricCount} docs={o.linkedDocumentCount}
                </span>
              </div>
            ))}
          {expanded === "renames" &&
            preview.potentialRenames.slice(0, 100).map((r) => (
              <div key={r.oldAssetIdInternal} className="import-preview__row">
                <span className="import-preview__code">
                  {r.oldAssetIdInternal} → {r.newAssetIdInternal}
                </span>
                <span className="import-preview__name">{r.displayName}</span>
                <span
                  className={`import-preview__match import-preview__match--${r.matchScore}`}
                >
                  {r.matchScore}
                </span>
              </div>
            ))}
          {expanded === "errors" &&
            preview.parseErrors.slice(0, 100).map((e, i) => (
              <div key={i} className="import-preview__row">
                <span className="import-preview__code">row {e.row}</span>
                <span className="import-preview__name">{e.reason}</span>
              </div>
            ))}
          {expanded === "sfi" &&
            preview.sfiWarnings.slice(0, 100).map((w, i) => (
              <div
                key={`${w.assetIdInternal}-${i}`}
                className="import-preview__row"
              >
                <span className="import-preview__code">{w.assetIdInternal}</span>
                <span className="import-preview__name">
                  {w.reason === "missing"
                    ? "no SFI sub-group"
                    : `unknown SFI code "${w.sfiSub}"`}
                </span>
                <span className="import-preview__meta">
                  {w.reason === "missing" ? "unclassified" : "not in catalog"}
                </span>
              </div>
            ))}
          {expanded &&
            ((expanded === "create" && preview.counts.create > 100) ||
              (expanded === "update" && preview.counts.update > 100) ||
              (expanded === "orphans" && preview.counts.orphans > 100) ||
              (expanded === "renames" && preview.counts.renames > 100)) && (
              <div className="import-preview__placeholder">
                showing first 100 of many — apply will process all
              </div>
            )}
        </div>

        <div className="import-preview__opts">
          <label className="import-preview__opt">
            <input
              type="checkbox"
              checked={mergeRenames}
              onChange={(e) => setMergeRenames(e.target.checked)}
              disabled={preview.counts.renames === 0}
            />
            <span>
              Merge potential renames (move metric bindings + manuals from
              old → new asset, then delete old)
            </span>
          </label>
          <label className="import-preview__opt">
            <input
              type="checkbox"
              checked={deleteOrphans}
              onChange={(e) => setDeleteOrphans(e.target.checked)}
              disabled={preview.counts.orphans === 0}
            />
            <span>
              Delete orphans not in file ({preview.counts.orphans} assets — bindings will be cleared)
            </span>
          </label>
          <label className="import-preview__opt">
            <input
              type="checkbox"
              checked={snapshotBefore}
              onChange={(e) => setSnapshotBefore(e.target.checked)}
            />
            <span>
              Snapshot current state before applying (recommended — enables one-click rollback)
            </span>
          </label>
        </div>

        {error && <div className="import-preview__error">{error}</div>}

        <div className="import-preview__actions">
          <button
            type="button"
            className="import-preview__btn import-preview__btn--cancel"
            onClick={onClose}
            disabled={committing}
          >
            Cancel
          </button>
          <button
            type="button"
            className="import-preview__btn import-preview__btn--primary"
            onClick={() => void handleApply()}
            disabled={committing}
          >
            {committing
              ? "Applying…"
              : `Apply (${preview.counts.create} new + ${preview.counts.update} updates${deleteOrphans ? ` − ${preview.counts.orphans} orphans` : ""})`}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatPill({
  label,
  count,
  tone,
  onClick,
  active,
}: {
  label: string;
  count: number;
  tone: "green" | "blue" | "amber" | "purple" | "red";
  onClick: () => void;
  active: boolean;
}) {
  return (
    <button
      type="button"
      className={`import-preview__pill import-preview__pill--${tone} ${active ? "import-preview__pill--active" : ""}`}
      onClick={onClick}
      title={`Click to ${active ? "collapse" : "expand"} ${label.toLowerCase()}`}
    >
      <span className="import-preview__pill-n">{count}</span>
      <span className="import-preview__pill-l">{label}</span>
    </button>
  );
}
