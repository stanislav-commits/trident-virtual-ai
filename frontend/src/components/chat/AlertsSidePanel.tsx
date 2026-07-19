import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import {
  listAlerts,
  acknowledgeAlert,
  type Alert,
} from "../../api/alertsApi";

interface AlertsSidePanelProps {
  token: string | null;
  shipId: string | null | undefined;
  closing?: boolean;
  /** Suppress the width open/close animation (when swapped in for another panel). */
  noAnim?: boolean;
  onAskAi: (alert: Alert) => void;
}

type Sev = "critical" | "high" | "warning" | "info";
type DisplayStatus = "active" | "acknowledged" | "cleared";
type FilterTab = "all" | "active" | "acknowledged";

// Muted "Night Bridge" palette: severity is a small accent (thin bar + dot +
// small badge) drawn from our status tokens, never a saturated fill.
//   critical → --status-danger, high/warning → --status-warn,
//   info → neutral muted text. `bg` is a faint color-mix wash for the accent.
const SEV: Record<
  Sev,
  { label: string; color: string; bg: string; bar: string; Icon: () => ReactElement }
> = {
  critical: {
    label: "Critical",
    // Softer than --alarm-critical on purpose: this red repeats across every
    // critical card + chip in the open panel — the neon badge tone is
    // reserved for the single sparse top-bar bell count, not for body content.
    color: "var(--status-danger-soft, var(--alarm-critical))",
    bg: "color-mix(in srgb, var(--status-danger-soft, var(--alarm-critical)) 16%, transparent)",
    bar: "var(--status-danger-soft, var(--alarm-critical))",
    Icon: IconAlertCircle,
  },
  high: {
    label: "High",
    color: "var(--status-warn)",
    bg: "color-mix(in srgb, var(--status-warn) 12%, transparent)",
    bar: "var(--status-warn)",
    Icon: IconAlertTriangle,
  },
  warning: {
    label: "Warning",
    color: "var(--status-warn)",
    bg: "color-mix(in srgb, var(--status-warn) 12%, transparent)",
    bar: "var(--status-warn)",
    Icon: IconAlertTriangle,
  },
  info: {
    label: "Info",
    color: "var(--chat-text-muted)",
    bg: "color-mix(in srgb, var(--chat-text-muted) 12%, transparent)",
    bar: "var(--chat-text-muted)",
    Icon: IconInfo,
  },
};

function sevOf(a: Alert): Sev {
  return (["critical", "high", "warning", "info"] as Sev[]).includes(a.severity as Sev)
    ? (a.severity as Sev)
    : "warning";
}
function statusOf(a: Alert): DisplayStatus {
  if (a.status === "resolved") return "cleared";
  if (a.ackedAt) return "acknowledged";
  return "active";
}
function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function AlarmCard({
  alarm,
  onAcknowledge,
  onAskAi,
  onDismiss,
}: {
  alarm: Alert;
  onAcknowledge: (a: Alert) => void;
  onAskAi: (a: Alert) => void;
  onDismiss: (a: Alert) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const sev = SEV[sevOf(alarm)];
  const status = statusOf(alarm);
  const isActive = status === "active";

  return (
    <div
      className={`alarm-card${isActive ? " alarm-card--active" : ""}`}
      style={{ ["--sev" as string]: sev.color, ["--sev-bg" as string]: sev.bg, ["--sev-bar" as string]: sev.bar }}
    >
      <span className="alarm-card__bar" />
      <div className="alarm-card__main">
        <div className="alarm-card__icon">
          <sev.Icon />
        </div>
        <div className="alarm-card__content">
          <div className="alarm-card__meta">
            <span className="alarm-badge alarm-badge--sev">
              <span className="alarm-dot" />
              {sev.label}
            </span>
            <span className={`alarm-badge alarm-badge--status alarm-badge--${status}`}>
              {status === "acknowledged" && <IconCheck />}
              {status === "active" ? "Active" : status === "acknowledged" ? "Acknowledged" : "Cleared"}
            </span>
            {alarm.source === "certificate" && (
              <span className="alarm-badge alarm-badge--cert">Certificate</span>
            )}
          </div>

          <h3 className="alarm-card__title">{alarm.title}</h3>
          {alarm.assetName && <p className="alarm-card__source">{alarm.assetName}</p>}

          {alarm.message && (
            <>
              <button
                type="button"
                className="alarm-card__expand"
                onClick={() => setExpanded((e) => !e)}
              >
                <IconChevron up={expanded} />
                {expanded ? "Less" : "Details"}
              </button>
              {expanded && <p className="alarm-card__desc">{alarm.message}</p>}
            </>
          )}
        </div>

        <div className="alarm-card__aside">
          <span className="alarm-card__time">
            <IconClock />
            {fmtWhen(alarm.startedAt)}
          </span>
          {alarm.value != null && (
            <div className="alarm-card__value">{alarm.value.toFixed(1)}</div>
          )}
        </div>
      </div>

      {status !== "cleared" && (
        <div className="alarm-card__actions">
          {isActive && (
            <button type="button" className="alarm-btn alarm-btn--ack" onClick={() => onAcknowledge(alarm)}>
              <IconCheck />
              Acknowledge
            </button>
          )}
          <button
            type="button"
            className="alarm-btn alarm-btn--ai"
            onClick={() => onAskAi(alarm)}
            title="AI analysis"
            aria-label="AI analysis"
          >
            <IconSparkles />
          </button>
          <button type="button" className="alarm-btn alarm-btn--dismiss" onClick={() => onDismiss(alarm)}>
            <IconX />
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

export function AlertsSidePanel({ token, shipId, closing, noAnim, onAskAi }: AlertsSidePanelProps) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(false);
  // Open on Active — an alarm panel is about what needs attention NOW.
  const [filter, setFilter] = useState<FilterTab>("active");
  const [sevFilter, setSevFilter] = useState<Sev | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const reload = useCallback(() => {
    if (!token || !shipId) {
      setAlerts([]);
      return;
    }
    setLoading(true);
    listAlerts(token, shipId)
      .then(setAlerts)
      .catch(() => setAlerts([]))
      .finally(() => setLoading(false));
  }, [token, shipId]);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 20000);
    return () => clearInterval(id);
  }, [reload]);

  const visible = useMemo(
    () => alerts.filter((a) => !dismissed.has(a.id)),
    [alerts, dismissed],
  );
  const counts = useMemo(() => {
    let active = 0,
      critical = 0,
      ack = 0;
    for (const a of visible) {
      const s = statusOf(a);
      if (s === "active") {
        active++;
        if (sevOf(a) === "critical") critical++;
      } else if (s === "acknowledged") ack++;
    }
    return { active, critical, ack };
  }, [visible]);

  // Alarms in the current status tab (before the severity chip filter).
  const statusFiltered = useMemo(
    () =>
      visible.filter((a) => {
        const s = statusOf(a);
        if (filter === "active") return s === "active";
        if (filter === "acknowledged") return s === "acknowledged";
        return true;
      }),
    [visible, filter],
  );

  // Per-severity counts within the current tab — drives the filter chips.
  const sevCounts = useMemo(() => {
    const c: Record<Sev, number> = { critical: 0, high: 0, warning: 0, info: 0 };
    for (const a of statusFiltered) c[sevOf(a)]++;
    return c;
  }, [statusFiltered]);

  const filtered = useMemo(() => {
    const order: Record<Sev, number> = { critical: 0, high: 1, warning: 2, info: 3 };
    return statusFiltered
      .filter((a) => !sevFilter || sevOf(a) === sevFilter)
      .sort(
        (a, b) =>
          order[sevOf(a)] - order[sevOf(b)] || b.startedAt.localeCompare(a.startedAt),
      );
  }, [statusFiltered, sevFilter]);

  const ack = async (a: Alert) => {
    if (!token || !shipId) return;
    try {
      await acknowledgeAlert(token, shipId, a.id);
      window.dispatchEvent(new CustomEvent("trident:alerts-changed"));
      reload();
    } catch {
      /* ignore */
    }
  };
  const ackAll = async () => {
    const actives = visible.filter((a) => statusOf(a) === "active");
    for (const a of actives) await ack(a);
  };
  const dismiss = (a: Alert) =>
    setDismissed((prev) => new Set(prev).add(a.id));

  const tabs: { key: FilterTab; label: string; count: number }[] = [
    { key: "all", label: "All", count: visible.length },
    { key: "active", label: "Active", count: counts.active },
    { key: "acknowledged", label: "Ack'd", count: counts.ack },
  ];

  return (
    <aside
      className={`chat-pms-panel${closing ? " chat-pms-panel--closing" : ""}${noAnim ? " chat-pms-panel--noanim" : ""}`}
      aria-label="Alarms"
    >
      <div className="chat-pms-panel__inner alarm-panel">
        {/* Header */}
        <div className="alarm-panel__header">
          <div className="alarm-panel__heading">
            <div>
              <div className="alarm-panel__title">Alarm Notifications</div>
              {counts.critical > 0 ? (
                <div className="alarm-panel__sub alarm-panel__sub--crit">
                  {counts.critical} critical alarm{counts.critical > 1 ? "s" : ""} need attention
                </div>
              ) : (
                <div className="alarm-panel__sub">
                  {counts.active > 0 ? `${counts.active} active` : "All clear"}
                </div>
              )}
            </div>
          </div>
          {counts.active > 0 && (
            <button type="button" className="alarm-panel__ackall" onClick={() => void ackAll()}>
              <IconCheck />
              Ack All
            </button>
          )}
        </div>

        {/* Severity filter chips — click to show only that severity, click again to clear */}
        {statusFiltered.length > 0 && (
          <div className="alarm-panel__chips" role="group" aria-label="Filter by severity">
            {(["critical", "high", "warning", "info"] as Sev[]).map((s) => {
              const n = sevCounts[s];
              if (!n) return null;
              const cfg = SEV[s];
              const on = sevFilter === s;
              return (
                <button
                  key={s}
                  type="button"
                  className={`alarm-chip${on ? " alarm-chip--on" : ""}`}
                  style={{ ["--sev" as string]: cfg.color, ["--sev-bg" as string]: cfg.bg }}
                  onClick={() => setSevFilter((prev) => (prev === s ? null : s))}
                  aria-pressed={on}
                >
                  <cfg.Icon />
                  {n} {cfg.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Tabs */}
        <div className="alarm-panel__tabs">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`alarm-tab${filter === t.key ? " alarm-tab--on" : ""}`}
              onClick={() => {
                setFilter(t.key);
                setSevFilter(null);
              }}
            >
              {t.label}
              <span className="alarm-tab__count">{t.count}</span>
            </button>
          ))}
        </div>

        {/* List */}
        <div className="alarm-panel__list">
          {loading && alerts.length === 0 && (
            <div className="alarm-panel__empty">Loading alarms…</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="alarm-panel__emptybox">
              <div className="alarm-panel__emptyicon">
                <IconBellOff />
              </div>
              <div className="alarm-panel__emptytitle">No alarms</div>
              <div className="alarm-panel__emptysub">This view is clear</div>
            </div>
          )}
          {filtered.map((a) => (
            <AlarmCard
              key={a.id}
              alarm={a}
              onAcknowledge={(x) => void ack(x)}
              onAskAi={onAskAi}
              onDismiss={dismiss}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

/* ── inline icons (lucide-style) ── */
function svg(children: ReactElement, size = 14) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}
function IconAlertCircle() { return svg(<><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>, 16); }
function IconAlertTriangle() { return svg(<><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>, 16); }
function IconInfo() { return svg(<><circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" /></>, 16); }
function IconBellOff() { return svg(<><path d="M13.73 21a2 2 0 0 1-3.46 0" /><path d="M18.63 13A17.89 17.89 0 0 1 18 8" /><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" /><path d="M18 8a6 6 0 0 0-9.33-5" /><line x1="1" y1="1" x2="23" y2="23" /></>, 22); }
function IconCheck() { return svg(<><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></>); }
function IconX() { return svg(<><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></>); }
function IconClock() { return svg(<><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></>, 12); }
function IconSparkles() { return svg(<><path d="M12 3l1.9 4.8L18.7 9.7l-4.8 1.9L12 16.4l-1.9-4.8L5.3 9.7l4.8-1.9z" /></>); }
function IconChevron({ up }: { up: boolean }) { return svg(up ? <polyline points="18 15 12 9 6 15" /> : <polyline points="6 9 12 15 18 9" />, 12); }
