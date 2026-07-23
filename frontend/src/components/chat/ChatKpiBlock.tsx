import type { ChatKpiBlockDto, ChatKpiItemDto } from "../../types/chat";

/**
 * Draws one or a few KPI ring gauges the metric analyzer produced (via the
 * render_kpi tool) — a quick-glance status view. Presentation-only: every
 * value already came from the model's other tools.
 */

const STATUS_COLOR: Record<"ok" | "warn" | "critical", string> = {
  ok: "#3fb950",
  warn: "#e0a800",
  critical: "#d9534f",
};

function autoStatus(item: ChatKpiItemDto): "ok" | "warn" | "critical" {
  if (item.status) return item.status;
  if (item.format !== "percent") return "ok";
  const span = item.max - item.min || 1;
  const share = ((item.value - item.min) / span) * 100;
  if (share >= 50) return "ok";
  if (share >= 20) return "warn";
  return "critical";
}

function formatValue(item: ChatKpiItemDto): string {
  const n = Number.isInteger(item.value) ? item.value.toString() : item.value.toFixed(1);
  if (item.format === "percent" && !item.unit) return `${n}%`;
  return item.unit ? `${n} ${item.unit}` : n;
}

const R = 34;
const CIRCUMFERENCE = 2 * Math.PI * R;

function KpiGauge({ item }: { item: ChatKpiItemDto }) {
  const span = item.max - item.min || 1;
  const pct = Math.max(0, Math.min(100, ((item.value - item.min) / span) * 100));
  const color = STATUS_COLOR[autoStatus(item)];
  const offset = CIRCUMFERENCE * (1 - pct / 100);

  return (
    <div className="chat-kpi__card">
      <svg
        className="chat-kpi__ring"
        width="88"
        height="88"
        viewBox="0 0 88 88"
        aria-hidden
      >
        <circle
          cx="44"
          cy="44"
          r={R}
          fill="none"
          strokeWidth="7"
          className="chat-kpi__ring-track"
        />
        <circle
          cx="44"
          cy="44"
          r={R}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          stroke={color}
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          transform="rotate(-90 44 44)"
        />
        <text x="44" y="41" textAnchor="middle" className="chat-kpi__ring-value">
          {formatValue(item)}
        </text>
        {item.format === "percent" && (
          <text x="44" y="56" textAnchor="middle" className="chat-kpi__ring-sub">
            {item.min}–{item.max}
            {item.unit ?? ""}
          </text>
        )}
      </svg>
      <span className="chat-kpi__label">{item.label}</span>
    </div>
  );
}

export default function ChatKpiBlock({ kpi }: { kpi: ChatKpiBlockDto }) {
  if (kpi.items.length === 0) return null;

  return (
    <div className="chat-kpi">
      {kpi.title && (
        <div className="chat-kpi__header">
          <span className="chat-kpi__title">{kpi.title}</span>
        </div>
      )}
      <div className="chat-kpi__row">
        {kpi.items.map((item, i) => (
          <KpiGauge key={`${item.label}-${i}`} item={item} />
        ))}
      </div>
    </div>
  );
}
