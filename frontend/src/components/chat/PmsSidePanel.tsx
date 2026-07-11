import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import {
  listPmsTasks,
  completePmsTask,
  addAssetHoursReading,
  type PmsTaskDto,
  type PmsStatus,
} from "../../api/pmsApi";

interface PmsSidePanelProps {
  token: string | null;
  shipId: string | null | undefined;
  closing?: boolean;
  /** Suppress the width open/close animation (when swapped in for another panel). */
  noAnim?: boolean;
}

// Maps onto the app design tokens so the panel matches the main screen.
const T = {
  bg: "var(--sidebar-bg)",
  app: "var(--sidebar-bg)",
  panel: "var(--chat-surface-2)",
  raised: "var(--chat-surface-3)",
  line: "var(--chat-border)",
  lineSoft: "var(--chat-border)",
  text: "var(--chat-text)",
  dim: "var(--chat-text-muted)",
  faint: "var(--chat-text-subtle)",
  hero: "var(--status-warn)",
  alarm: "var(--status-danger)",
  ok: "var(--status-ok)",
} as const;
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

type Horizon = "overdue" | "week" | "scheduled";
const SECTIONS: { key: Horizon; label: string; color: string }[] = [
  { key: "overdue", label: "Overdue", color: T.alarm },
  { key: "week", label: "Due this week", color: T.hero },
  { key: "scheduled", label: "Scheduled", color: T.ok },
];
const HORIZON_RANK: Record<Horizon, number> = { overdue: 0, week: 1, scheduled: 2 };
const statusColor = (s: PmsStatus) =>
  s === "overdue" ? T.alarm : s === "due-soon" ? T.hero : T.ok;

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const fmtDate = (d: Date) => `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
const fmtTime = (d: Date) =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function hoursRemaining(t: PmsTaskDto): number | null {
  if (t.dueHours == null || t.currentHours == null) return null;
  return t.dueHours - t.currentHours;
}
function intervalText(t: PmsTaskDto): string | null {
  if (t.intervalHours != null) return `${t.intervalHours} h`;
  if (t.intervalValue != null) return `${t.intervalValue} ${t.intervalUnit ?? "months"}`;
  return null;
}
function isHours(t: PmsTaskDto): boolean {
  return t.intervalHours != null && t.dueHours != null && t.currentHours != null;
}
function dueLabel(t: PmsTaskDto, now: Date): string {
  if (!t.dueDate) return t.due;
  const d = new Date(t.dueDate + "T00:00:00");
  const days = Math.round((d.getTime() - now.getTime()) / 86400000);
  if (days < 0) return `${-days}d overdue`;
  if (days === 0) return "today";
  return fmtDate(d).replace(/^(\w{3}) (\d+) (\w{3})$/, "$1 $2 $3");
}
function isCritical(t: PmsTaskDto): boolean {
  return t.priority === "critical" || t.priority === "high";
}
function daysUntil(dateStr: string, now: Date): number {
  const d = new Date(dateStr + "T00:00:00");
  const n = new Date(now);
  n.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - n.getTime()) / 86400000);
}
/** Real horizon by actual due date (not the backend's 30-day "due-soon"). */
function horizonOf(t: PmsTaskDto, now: Date): Horizon {
  if (t.dueDate) {
    const days = daysUntil(t.dueDate, now);
    if (days < 0) return "overdue";
    return days <= 7 ? "week" : "scheduled";
  }
  const rem = hoursRemaining(t);
  if (rem != null) {
    if (rem < 0) return "overdue";
    return t.status === "due-soon" ? "week" : "scheduled";
  }
  return t.status === "overdue"
    ? "overdue"
    : t.status === "due-soon"
      ? "week"
      : "scheduled";
}

/** Small circular hours gauge (current/due). */
function Ring({ ratio, color }: { ratio: number; color: string }) {
  const r = 17;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, ratio));
  return (
    <svg width={42} height={42} viewBox="0 0 42 42">
      <circle cx={21} cy={21} r={r} fill="none" stroke={T.line} strokeWidth={3} />
      <circle
        cx={21}
        cy={21}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform="rotate(-90 21 21)"
      />
    </svg>
  );
}

export function PmsSidePanel({ token, shipId, closing, noAnim }: PmsSidePanelProps) {
  const [tasks, setTasks] = useState<PmsTaskDto[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [tab, setTab] = useState<"all" | "due" | "critical">("all");
  const [selId, setSelId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [weekOffset, setWeekOffset] = useState(0);
  // Default to today's tasks only; "Show all" (selDay = null) reveals the full list.
  const [selDay, setSelDay] = useState<string | null>(() => dayKey(new Date()));

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(id);
  }, []);

  const reload = () => {
    if (!token || !shipId) {
      setTasks([]);
      return;
    }
    setIsLoading(true);
    setError(null);
    listPmsTasks(token, shipId)
      .then((r) => setTasks(r.filter((t) => t.completedAt == null)))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : "Failed to load"),
      )
      .finally(() => setIsLoading(false));
  };
  useEffect(reload, [token, shipId]);

  const filtered = useMemo(() => {
    if (tab === "due")
      return tasks.filter((t) => t.status === "overdue" || t.status === "due-soon");
    if (tab === "critical") return tasks.filter(isCritical);
    return tasks;
  }, [tasks, tab]);

  const byDue = (a: PmsTaskDto, b: PmsTaskDto) => {
    const at = a.dueDate ? Date.parse(a.dueDate) : Infinity;
    const bt = b.dueDate ? Date.parse(b.dueDate) : Infinity;
    if (at !== bt) return at - bt;
    return (hoursRemaining(a) ?? Infinity) - (hoursRemaining(b) ?? Infinity);
  };

  const grouped = useMemo(() => {
    const sorted = [...filtered].sort((a, b) => {
      const r = HORIZON_RANK[horizonOf(a, now)] - HORIZON_RANK[horizonOf(b, now)];
      return r !== 0 ? r : byDue(a, b);
    });
    return SECTIONS.map((s) => ({
      ...s,
      items: sorted.filter((t) => horizonOf(t, now) === s.key),
    }));
  }, [filtered, now]);

  // tasks due on the selected day (when a week-strip day is tapped)
  const dayTasks = useMemo(() => {
    if (!selDay) return null;
    return tasks
      .filter((t) => t.dueDate && dayKey(new Date(t.dueDate + "T00:00:00")) === selDay)
      .sort(byDue);
  }, [tasks, selDay]);

  // week strip — Mon..Sun of (current + weekOffset) week, with per-day counts
  const week = useMemo(() => {
    const monday = new Date(now);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) + weekOffset * 7);
    monday.setHours(0, 0, 0, 0);
    const counts = new Map<string, number>();
    for (const t of tasks)
      if (t.dueDate) {
        const k = dayKey(new Date(t.dueDate + "T00:00:00"));
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const k = dayKey(d);
      return { d, key: k, isToday: k === dayKey(now), count: counts.get(k) ?? 0 };
    });
  }, [now, tasks, weekOffset]);

  const weekLabel = useMemo(() => {
    if (week.length === 0) return "";
    const a = week[0].d;
    const b = week[6].d;
    return `${a.getDate()} ${MON[a.getMonth()]} – ${b.getDate()} ${MON[b.getMonth()]}`;
  }, [week]);

  const counts = useMemo(() => {
    let overdue = 0,
      due = 0,
      ok = 0;
    for (const t of tasks) {
      const h = horizonOf(t, now);
      if (h === "overdue") overdue++;
      else if (h === "week") due++;
      else ok++;
    }
    return { overdue, due, ok };
  }, [tasks, now]);

  const selected = selId ? tasks.find((t) => t.id === selId) ?? null : null;

  const markDone = async (t: PmsTaskDto) => {
    if (!token || !shipId) return;
    setBusy(true);
    try {
      await completePmsTask(token, shipId, t.id, {
        doneAtHours: t.currentHours ?? undefined,
      });
      setSelId(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const logHours = async (t: PmsTaskDto, hours: number) => {
    if (!token || !shipId) return;
    const assetId = t.assets[0]?.id;
    if (!assetId) {
      setError("This reminder has no linked asset.");
      return;
    }
    setBusy(true);
    try {
      // Logging the reading also rolls the monthly reminder forward.
      await addAssetHoursReading(token, shipId, assetId, { hours });
      setSelId(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to log reading");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      className={`chat-pms-panel${closing ? " chat-pms-panel--closing" : ""}${noAnim ? " chat-pms-panel--noanim" : ""}`}
      aria-label="Tasks"
      style={{ background: T.bg, color: T.text }}
    >
      <div className="chat-pms-panel__inner">
      {selected ? (
        <Detail
          task={selected}
          now={now}
          busy={busy}
          onBack={() => setSelId(null)}
          onDone={() => void markDone(selected)}
          onLogHours={(h) => void logHours(selected, h)}
        />
      ) : (
        <>
          {/* header */}
          <div style={{ padding: "13px 16px 12px", background: T.app, borderBottom: `1px solid ${T.line}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontFamily: SANS, fontSize: 17, fontWeight: 600, color: T.text }}>
                Tasks
              </span>
              <span style={{ fontFamily: MONO, fontSize: 12.5, color: T.dim }}>{fmtDate(now)}</span>
            </div>
            <div style={{ marginTop: 8, fontFamily: SANS, fontSize: 13, display: "flex", gap: 14 }}>
              <span><b style={{ color: T.alarm }}>{counts.overdue}</b> <span style={{ color: T.dim }}>overdue</span></span>
              <span><b style={{ color: T.hero }}>{counts.due}</b> <span style={{ color: T.dim }}>due</span></span>
              <span><b style={{ color: T.ok }}>{counts.ok}</b> <span style={{ color: T.dim }}>scheduled</span></span>
            </div>
          </div>

          {/* week strip — navigable + tap a day to filter */}
          <div style={{ padding: "8px 8px 10px", borderBottom: `1px solid ${T.line}` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 6px 6px" }}>
              <button type="button" onClick={() => setWeekOffset((o) => o - 1)} style={navBtn} aria-label="Previous week">‹</button>
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.dim }}>
                {weekOffset === 0 ? "This week" : weekLabel}
              </span>
              <button type="button" onClick={() => setWeekOffset((o) => o + 1)} style={navBtn} aria-label="Next week">›</button>
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              {week.map((w) => {
                const isSel = selDay === w.key;
                return (
                  <button
                    key={w.key}
                    type="button"
                    onClick={() => setSelDay(isSel ? null : w.key)}
                    style={{
                      flex: 1,
                      textAlign: "center",
                      padding: "5px 0 6px",
                      borderRadius: 8,
                      cursor: "pointer",
                      background: isSel ? `${T.hero}26` : w.isToday ? `${T.hero}12` : "transparent",
                      border: isSel
                        ? `1px solid ${T.hero}`
                        : w.isToday
                          ? `1px solid ${T.hero}66`
                          : "1px solid transparent",
                    }}
                  >
                    <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: 0.5, color: T.faint }}>
                      {DOW[w.d.getDay()].toUpperCase()}
                    </div>
                    <div style={{ fontFamily: SANS, fontSize: 15, fontWeight: 600, color: w.isToday || isSel ? T.hero : T.text, marginTop: 2 }}>
                      {w.d.getDate()}
                    </div>
                    <div style={{ display: "flex", justifyContent: "center", gap: 2, marginTop: 3, height: 4 }}>
                      {Array.from({ length: Math.min(w.count, 3) }).map((_, j) => (
                        <span key={j} style={{ width: 3, height: 3, borderRadius: "50%", background: w.count ? T.hero : "transparent" }} />
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* tabs */}
          <div style={{ display: "flex", gap: 6, padding: "10px 12px 6px" }}>
            {(["all", "due", "critical"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTab(k)}
                style={{
                  flex: 1,
                  fontFamily: SANS,
                  fontSize: 12.5,
                  padding: "6px 0",
                  borderRadius: 7,
                  cursor: "pointer",
                  textTransform: "capitalize",
                  color: tab === k ? T.text : T.dim,
                  background: tab === k ? T.raised : "transparent",
                  border: `1px solid ${tab === k ? T.line : "transparent"}`,
                }}
              >
                {k}
              </button>
            ))}
          </div>

          {/* list */}
          <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "2px 12px 16px" }}>
            {isLoading && <div style={stateStyle}>Loading maintenance…</div>}
            {!isLoading && error && <div style={{ ...stateStyle, color: T.alarm }}>{error}</div>}

            {/* day-filter mode: tasks due on the tapped day */}
            {!isLoading && !error && dayTasks && (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 4px 8px" }}>
                  <span style={{ fontFamily: SANS, fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: T.text }}>
                    {selDay === dayKey(now)
                      ? "Today"
                      : fmtDate(new Date(selDay + "T00:00:00"))}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelDay(null)}
                    style={{ marginLeft: "auto", background: "transparent", border: 0, color: T.hero, fontFamily: SANS, fontSize: 12, cursor: "pointer" }}
                  >
                    Show all
                  </button>
                </div>
                {dayTasks.length === 0 ? (
                  <div style={stateStyle}>No tasks due on this day</div>
                ) : (
                  dayTasks.map((t) => (
                    <TaskCard key={t.id} task={t} now={now} onClick={() => setSelId(t.id)} />
                  ))
                )}
              </>
            )}

            {/* grouped mode */}
            {!isLoading && !error && !dayTasks && filtered.length === 0 && (
              <div style={stateStyle}>No maintenance here</div>
            )}
            {!isLoading &&
              !error &&
              !dayTasks &&
              grouped.map((section) =>
                section.items.length === 0 ? null : (
                  <div key={section.key}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 4px 7px" }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: section.color }} />
                      <span style={{ fontFamily: SANS, fontSize: 11.5, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: T.text }}>
                        {section.label}
                      </span>
                      <span style={{ marginLeft: "auto", fontFamily: MONO, fontSize: 11, color: T.faint }}>
                        {section.items.length}
                      </span>
                    </div>
                    {section.key === "week" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 4px 6px" }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.hero }} />
                        <span style={{ flex: 1, height: 1, background: `${T.hero}33` }} />
                        <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.hero }}>
                          NOW · {fmtTime(now)}
                        </span>
                      </div>
                    )}
                    {section.items.map((t) => (
                      <TaskCard key={t.id} task={t} now={now} onClick={() => setSelId(t.id)} />
                    ))}
                  </div>
                ),
              )}
          </div>
        </>
      )}
      </div>
    </aside>
  );
}

const stateStyle: CSSProperties = {
  fontFamily: SANS,
  fontSize: 13,
  color: T.dim,
  padding: "28px 16px",
  textAlign: "center",
};
const navBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: T.dim,
  fontSize: 18,
  lineHeight: 1,
  cursor: "pointer",
  padding: "0 6px",
};

function TaskCard({ task, now, onClick }: { task: PmsTaskDto; now: Date; onClick: () => void }) {
  const assetNames = task.assets.map((a) => a.name).filter(Boolean).join(" · ");
  const sc = statusColor(task.status);
  const hours = isHours(task);
  const remaining = hoursRemaining(task);
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: "relative",
        display: "block",
        width: "100%",
        textAlign: "left",
        background: T.panel,
        border: `1px solid ${T.line}`,
        borderRadius: 10,
        padding: "11px 13px 11px 15px",
        marginBottom: 8,
        cursor: "pointer",
        overflow: "hidden",
      }}
    >
      <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: sc }} />
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          {assetNames && (
            <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: 0.4, color: T.hero, marginBottom: 5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {assetNames}
            </div>
          )}
          <div style={{ fontFamily: SANS, fontSize: 15, fontWeight: 600, color: T.text, lineHeight: 1.25 }}>
            {task.task}
          </div>
          {task.description && (
            <div style={{ fontFamily: SANS, fontSize: 12, color: T.dim, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {task.description.split("\n")[0]}
            </div>
          )}
        </div>
        <div style={{ flexShrink: 0, textAlign: "right" }}>
          {hours && remaining != null ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <Ring ratio={(task.currentHours ?? 0) / (task.dueHours || 1)} color={sc} />
              <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.dim, marginTop: 2 }}>
                {task.currentHours}/{task.dueHours}h
              </span>
            </div>
          ) : (
            <span style={{ fontFamily: MONO, fontSize: 12.5, color: task.status === "overdue" ? T.alarm : T.dim }}>
              {dueLabel(task, now)}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function Detail({
  task,
  now,
  busy,
  onBack,
  onDone,
  onLogHours,
}: {
  task: PmsTaskDto;
  now: Date;
  busy: boolean;
  onBack: () => void;
  onDone: () => void;
  onLogHours: (hours: number) => void;
}) {
  const [reading, setReading] = useState("");
  const isHoursReminder = task.source === "hours_reminder";
  const assetNames = task.assets.map((a) => a.name).filter(Boolean).join(" · ");
  const sc = statusColor(task.status);
  const hours = isHours(task);
  const remaining = hoursRemaining(task);
  const interval = intervalText(task);
  const sub = [
    interval,
    task.lastDone ? `last ${task.lastDone}` : null,
    task.department,
  ]
    .filter(Boolean)
    .join(" · ");
  const sectStyle: CSSProperties = {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    color: T.dim,
    margin: "0 0 8px",
  };
  return (
    <>
      <div style={{ padding: "13px 16px", borderBottom: `1px solid ${T.line}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <button type="button" onClick={onBack} style={{ background: "transparent", border: 0, color: T.dim, fontFamily: SANS, fontSize: 13, cursor: "pointer", padding: 0 }}>
          ‹ All tasks
        </button>
        <span style={{ fontFamily: MONO, fontSize: 11, color: T.faint }}>
          {task.id.slice(0, 8)}
        </span>
      </div>
      <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 10 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: sc }} />
          <span style={{ fontFamily: MONO, fontSize: 11, letterSpacing: 0.6, textTransform: "uppercase", color: isCritical(task) ? T.alarm : T.ok }}>
            {isCritical(task) ? "Critical" : "Routine"}
          </span>
          {task.category && <span style={{ fontFamily: SANS, fontSize: 12, color: T.faint }}>· {task.category}</span>}
        </div>
        {assetNames && (
          <div style={{ fontFamily: MONO, fontSize: 11.5, letterSpacing: 0.4, color: T.hero, marginBottom: 6 }}>{assetNames}</div>
        )}
        <div style={{ fontFamily: SANS, fontSize: 22, fontWeight: 600, color: T.text, lineHeight: 1.2 }}>{task.task}</div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, margin: "14px 0", paddingBottom: 14, borderBottom: `1px solid ${T.line}` }}>
          {hours && remaining != null && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
              <Ring ratio={(task.currentHours ?? 0) / (task.dueHours || 1)} color={sc} />
              <span style={{ fontFamily: MONO, fontSize: 10, color: T.dim, marginTop: 2 }}>{task.currentHours}/{task.dueHours}h</span>
            </div>
          )}
          <div>
            <div style={{ fontFamily: SANS, fontSize: 14, color: task.status === "overdue" ? T.alarm : T.text }}>
              {hours && remaining != null ? `${Math.max(remaining, 0)} h to service` : dueLabel(task, now)}
            </div>
            {sub && <div style={{ fontFamily: SANS, fontSize: 12, color: T.faint, marginTop: 3 }}>{sub}</div>}
          </div>
        </div>

        {task.description && (
          <div style={{ marginBottom: 18 }}>
            <div style={sectStyle}>Task description</div>
            <div style={{ fontFamily: SANS, fontSize: 13.5, color: T.text, lineHeight: 1.55 }}>{task.description}</div>
          </div>
        )}

        <div style={{ marginBottom: 18 }}>
          <div style={sectStyle}>Details</div>
          <Row label="Status" value={task.status === "overdue" ? "Overdue" : task.status === "due-soon" ? "Due soon" : "Scheduled"} color={sc} />
          {interval && <Row label="Interval" value={interval} />}
          {task.responsibleRole && <Row label="Responsible" value={task.responsibleRole} />}
          {task.department && <Row label="Department" value={task.department} />}
          {task.lastDone && <Row label="Last done" value={task.lastDone} />}
          {task.source === "compliance" && <Row label="Source" value="Compliance certificate" />}
        </div>
      </div>

      <div style={{ padding: "12px 16px", borderTop: `1px solid ${T.line}`, background: T.app }}>
        {isHoursReminder ? (
          <>
            <div style={{ fontFamily: MONO, fontSize: 10.5, letterSpacing: 0.6, textTransform: "uppercase", color: T.dim, marginBottom: 7 }}>
              Record running hours
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                inputMode="decimal"
                value={reading}
                placeholder="Hour counter reading"
                onChange={(e) => setReading(e.target.value.replace(/[^0-9.]/g, ""))}
                style={{ flex: 1, background: T.panel, border: `1px solid ${T.line}`, color: T.text, fontFamily: MONO, fontSize: 14, borderRadius: 8, padding: "10px 12px" }}
              />
              <button
                type="button"
                disabled={busy || !reading}
                onClick={() => onLogHours(Number(reading))}
                style={{ background: T.hero, border: 0, color: "#1a1206", fontFamily: SANS, fontSize: 14, fontWeight: 600, borderRadius: 8, padding: "0 16px", cursor: "pointer", opacity: busy || !reading ? 0.5 : 1 }}
              >
                {busy ? "Saving…" : "Log"}
              </button>
            </div>
            <button
              type="button"
              onClick={onBack}
              style={{ marginTop: 8, width: "100%", background: "transparent", border: `1px solid ${T.line}`, color: T.dim, fontFamily: SANS, fontSize: 13, borderRadius: 8, padding: "8px 0", cursor: "pointer" }}
            >
              Back
            </button>
          </>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              onClick={onDone}
              disabled={busy}
              style={{ flex: 1, background: T.hero, border: 0, color: "#1a1206", fontFamily: SANS, fontSize: 14, fontWeight: 600, borderRadius: 8, padding: "10px 0", cursor: "pointer" }}
            >
              {busy ? "Saving…" : "Mark done"}
            </button>
            <button
              type="button"
              onClick={onBack}
              style={{ background: "transparent", border: `1px solid ${T.line}`, color: T.dim, fontFamily: SANS, fontSize: 14, borderRadius: 8, padding: "10px 16px", cursor: "pointer" }}
            >
              Back
            </button>
          </div>
        )}
      </div>
    </>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 0", fontFamily: SANS, fontSize: 13 }}>
      <span style={{ color: T.faint }}>{label}</span>
      <span style={{ color: color ?? T.text, textTransform: "capitalize" }}>{value}</span>
    </div>
  );
}
