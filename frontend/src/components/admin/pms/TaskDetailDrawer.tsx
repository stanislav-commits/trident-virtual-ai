import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TrashIcon } from "../AdminPanelIcons";
import type { InventoryItem } from "../../../api/inventoryApi";
import {
  STATUS_LABEL,
  type PmsTask,
  deriveDue,
  deriveHours,
  descriptionLines,
  intervalLabel,
  nextHoursMark,
} from "./taskTypes";

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="pms-drawer__row">
      <span className="pms-drawer__row-label">{label}</span>
      <span className="pms-drawer__row-value">{value ?? "—"}</span>
    </div>
  );
}

/**
 * Right-side task drawer — everything about one maintenance job in read-only
 * form (status → asset → schedule → instructions → parts). All changes go
 * through the Edit button, which swaps this panel for the edit form.
 */
export function TaskDetailDrawer({
  task,
  parts,
  deptLabel,
  onClose,
  onEdit,
  onPerform,
  onReopen,
  onDelete,
}: {
  task: PmsTask;
  parts: InventoryItem[];
  deptLabel: (d?: string) => string | undefined;
  onClose: () => void;
  onEdit: () => void;
  onPerform: () => void;
  onReopen: () => void;
  onDelete: () => void;
}) {
  const planned = task.planning === "planned";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Hours progress: how far the counter has run into the service interval.
  const hoursBar = (() => {
    if (task.currentHours == null || task.dueHours == null) return null;
    const span =
      task.intervalHours ??
      (task.startHours != null ? task.dueHours - task.startHours : null);
    if (!span || span <= 0) return null;
    const start = task.dueHours - span;
    const pct = Math.max(0, Math.min(1, (task.currentHours - start) / span));
    return { pct, over: task.currentHours > task.dueHours };
  })();

  const nextDueHours =
    task.dueHours != null
      ? `${task.dueHours} h${
          task.currentHours != null
            ? ` · ${deriveHours(task.currentHours, task.dueHours).due}`
            : ""
        }`
      : task.intervalHours != null && task.currentHours != null
        ? `${nextHoursMark(task.currentHours, task.intervalHours)} h`
        : task.intervalHours != null
          ? "awaiting metric"
          : null;

  const lines = task.description ? descriptionLines(task.description) : [];

  return createPortal(
    <div className="pms-drawer__overlay" onClick={onClose}>
      <aside
        className="pms-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={task.task}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="pms-drawer__head">
          <div className="pms-drawer__head-main">
            <div className="pms-drawer__status-row">
              {task.completedAt ? (
                <span className="pms__status pms__status--done">Done</span>
              ) : (
                <span className={`pms__status pms__status--${task.status}`}>
                  {STATUS_LABEL[task.status]}
                </span>
              )}
              <span className={`pms__plan pms__plan--${task.planning}`}>
                {planned ? "Planned" : "Unplanned"}
              </span>
              <span className="pms__cat">{task.category}</span>
              {task.department && (
                <span className="pms__dept">{deptLabel(task.department)}</span>
              )}
              {task.source === "hours_reminder" && (
                <span className="pms__cat">monthly reading</span>
              )}
              {task.source === "compliance" && (
                <span className="pms__dept">from certificate</span>
              )}
            </div>
            {(task.taskCode || task.externalRef) && (
              <div className="pms-drawer__code">
                {task.taskCode}
                {task.externalRef && (
                  <span className="pms-drawer__code-ref">
                    {" "}· PMS ref {task.externalRef}
                  </span>
                )}
              </div>
            )}
            <h2 className="pms-drawer__title">{task.task}</h2>
          </div>
          <button
            type="button"
            className="pms-drawer__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="pms-drawer__body">
          {/* Asset */}
          <section className="pms-drawer__section">
            <div className="pms-drawer__section-head">Asset</div>
            {task.assets.length > 0 ? (
              <div className="pms__assets">
                {task.assets.map((a) => (
                  <span key={a.id} className="pms__asset-chip">
                    {a.name}
                  </span>
                ))}
              </div>
            ) : (
              <div className="pms-drawer__muted">No linked asset</div>
            )}
            {task.sfiGroupName && (
              <div className="pms__sfi" style={{ marginTop: 6 }}>
                {task.sfiGroup} · {task.sfiGroupName}
              </div>
            )}
          </section>

          {/* Responsible */}
          <section className="pms-drawer__section">
            <div className="pms-drawer__section-head">Responsible</div>
            <div className="pms-drawer__value">
              {task.responsibleRole ?? "—"}
            </div>
            {task.assigneeName && (
              <div className="pms-drawer__muted" style={{ marginTop: 4 }}>
                Person: {task.assigneeName}
              </div>
            )}
          </section>

          {/* Schedule */}
          <section className="pms-drawer__section">
            <div className="pms-drawer__section-head">Schedule</div>
            <Row
              label={planned ? "Next due" : "Due date"}
              value={
                task.dueDate
                  ? `${task.dueDate} · ${deriveDue(task.dueDate).due}`
                  : null
              }
            />
            {planned && (
              <Row
                label="Repeat"
                value={
                  task.repeatDate && task.intervalValue != null
                    ? `every ${intervalLabel(task.intervalValue, task.intervalUnit)}`
                    : null
                }
              />
            )}
            {(task.intervalHours != null ||
              task.dueHours != null ||
              task.currentHours != null) && (
              <>
                <Row
                  label="Service interval"
                  value={
                    task.intervalHours != null
                      ? `every ${task.intervalHours} h`
                      : null
                  }
                />
                <Row
                  label="Current hours"
                  value={
                    task.currentHours != null
                      ? `${task.currentHours} h`
                      : "from metrics (pending)"
                  }
                />
                <Row label="Next due (hours)" value={nextDueHours} />
                {hoursBar && (
                  <div
                    className={`pms-drawer__hoursbar${
                      hoursBar.over ? " pms-drawer__hoursbar--over" : ""
                    }`}
                    title={`${task.currentHours} / ${task.dueHours} h`}
                  >
                    <span style={{ width: `${hoursBar.pct * 100}%` }} />
                  </div>
                )}
              </>
            )}
            <Row
              label="Last done"
              value={
                task.lastDone ??
                (task.lastDoneHours != null ? `${task.lastDoneHours} h` : null)
              }
            />
            {task.completedAt && (
              <>
                <Row label="Completed" value={task.completedAt.slice(0, 10)} />
                {task.completedByName && (
                  <Row
                    label="Done by"
                    value={`${task.completedByName}${
                      task.completedByPosition
                        ? ` · ${task.completedByPosition}`
                        : ""
                    }`}
                  />
                )}
              </>
            )}
          </section>

          {/* Note left by whoever performed it — recurring tasks keep this
              even though completedAt itself resets to null on roll-forward. */}
          {task.completionNotes && (
            <section className="pms-drawer__section">
              <div className="pms-drawer__section-head">
                Note from last completion
              </div>
              <div className="pms-drawer__desc">{task.completionNotes}</div>
            </section>
          )}

          {/* Instructions / notes */}
          {lines.length > 0 && (
            <section className="pms-drawer__section">
              <div className="pms-drawer__section-head">Instructions</div>
              <div className="pms-drawer__desc">
                {lines.map((l, i) => (
                  <div
                    key={i}
                    className={
                      /^\d+[.)]/.test(l) || /^[-•]/.test(l)
                        ? "pms-drawer__desc-step"
                        : "pms-drawer__desc-line"
                    }
                  >
                    {l}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Parts & spares */}
          <section className="pms-drawer__section">
            <div className="pms-drawer__section-head">
              Parts &amp; spares
              {parts.length > 0 && (
                <span className="pms-drawer__count">{parts.length}</span>
              )}
            </div>
            {parts.length > 0 ? (
              <div className="pms-drawer__parts">
                {parts.map((p) => (
                  <div key={p.id} className="pms-drawer__part">
                    <div className="pms-drawer__part-main">
                      <span className="pms-drawer__part-name">{p.name}</span>
                      {p.partNumber && (
                        <span className="pms-drawer__part-no">
                          {p.partNumber}
                        </span>
                      )}
                    </div>
                    <div className="pms-drawer__part-side">
                      {p.quantity != null && (
                        <span>
                          ×{p.quantity}
                          {p.unit ? ` ${p.unit}` : ""}
                        </span>
                      )}
                      {p.location && (
                        <span className="pms-drawer__muted">{p.location}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="pms-drawer__muted">
                None linked — use Edit to attach spares.
              </div>
            )}
          </section>
        </div>

        {/* Footer actions */}
        <div className="pms-drawer__actions">
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--ghost pms__btn-danger"
            onClick={onDelete}
          >
            <TrashIcon /> Delete
          </button>
          <span className="pms-drawer__actions-gap" />
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--ghost"
            onClick={onEdit}
          >
            Edit
          </button>
          {task.completedAt ? (
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--primary"
              onClick={() => {
                onReopen();
                onClose();
              }}
            >
              Reopen
            </button>
          ) : (
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--primary"
              onClick={() => {
                onPerform();
                onClose();
              }}
            >
              Perform
            </button>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
