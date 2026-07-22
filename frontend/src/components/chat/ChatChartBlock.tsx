import { useMemo, useRef, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChatChartDto, ChatChartLabelsDto } from "../../types/chat";

/** Minimal shape of the state recharts (v3) passes to chart mouse handlers.
 *  On click the active fields are cleared, so we capture the hovered index on
 *  mouse-move and read it on click. */
interface ChartMouseState {
  activeIndex?: number | string | null;
  activeTooltipIndex?: number | string | null;
  activeLabel?: string | number;
}

interface SelectedPoint {
  t: number;
  items: Array<{ name: string; value: number }>;
}

/**
 * Draws a time-series chart the metric analyzer produced (via the
 * render_chart tool). Multiple series overlay on one chart. Timestamps are
 * unioned across series into recharts rows; empty buckets stay as gaps.
 */

// Distinct, readable on both light and dark themes.
const SERIES_COLORS = [
  "#2f81f7",
  "#e0a800",
  "#3fb950",
  "#d9534f",
];

interface ChartRow {
  t: number; // epoch ms — used for ordering + tick formatting
  [seriesName: string]: number | null;
}

function formatTick(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  // Sub-day span → show time; multi-day → show date; very wide → month/day.
  if (spanMs <= 36 * 3_600_000) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// Fallback when the server hasn't supplied translated labels yet (e.g. an
// older cached message) — English, same shape the backend's ChatUiLabelsService
// falls back to.
const ENGLISH_LABELS: ChatChartLabelsDto = {
  askPoint: "What happened here?",
  askInterval: "What happened in this window?",
  questionPointTemplate:
    'On the "{title}" chart: {when}. What was going on at that time? ' +
    "Check other metrics, events and alarms in that window and explain the cause.",
  questionIntervalTemplate:
    'On the "{title}" chart: the interval from {from} to {to}. ' +
    "What was going on and what drove the change? Check other metrics, " +
    "events and alarms in that window and explain the cause.",
};

/** Fills `{token}` placeholders in a translated template. Any token the
 *  vars map doesn't have is left as-is rather than silently vanishing, so a
 *  mistranslation is visible instead of producing garbled prose. */
function fillTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match,
  );
}

export default function ChatChartBlock({
  chart,
  onAsk,
  labels,
}: {
  chart: ChatChartDto;
  /** Send a follow-up question to the chat (click-a-point → "what happened
   *  here?"). Usually the message input's send handler. */
  onAsk?: (text: string) => void;
  /** Click-to-ask UI strings, translated server-side into the chat's
   *  language (any language). Falls back to English if absent. */
  labels?: ChatChartLabelsDto;
}) {
  const t = labels ?? ENGLISH_LABELS;
  const [selected, setSelected] = useState<SelectedPoint | null>(null);
  const [selectedInterval, setSelectedInterval] = useState<{
    t1: number;
    t2: number;
  } | null>(null);
  // Live drag highlight (epoch-ms x-range) while selecting an interval.
  const [dragHighlight, setDragHighlight] = useState<{
    x1: number;
    x2: number;
  } | null>(null);
  // Hovered bucket index (recharts clears it on click — see the mouse
  // handlers). Refs declared before any early return to satisfy rules of hooks.
  const hoverIndexRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const dragStartRef = useRef<number | null>(null);
  const dragEndRef = useRef<number | null>(null);
  const { rows, spanMs } = useMemo(() => {
    const byTs = new Map<number, ChartRow>();
    for (const series of chart.series) {
      for (const p of series.points) {
        const ms = Date.parse(p.t);
        if (Number.isNaN(ms)) continue;
        let row = byTs.get(ms);
        if (!row) {
          row = { t: ms };
          byTs.set(ms, row);
        }
        row[series.name] = p.v;
      }
    }
    const sorted = [...byTs.values()].sort((a, b) => a.t - b.t);
    const span =
      sorted.length > 1 ? sorted[sorted.length - 1].t - sorted[0].t : 0;
    return { rows: sorted, spanMs: span };
  }, [chart]);

  if (rows.length === 0) {
    return (
      <div className="chat-chart chat-chart--empty">
        <div className="chat-chart__empty">No data for this period.</div>
      </div>
    );
  }

  const seriesNames = chart.series.map((s) => s.name);
  const unit = chart.unit ?? "";
  const tickFormatter = (ms: number) => formatTick(ms, spanMs);
  const yTickFormatter = (v: number) => (unit ? `${v} ${unit}` : `${v}`);
  const labelFormatter = (value: unknown) => {
    const ms = typeof value === "number" ? value : Number(value);
    return Number.isNaN(ms) ? "" : new Date(ms).toLocaleString();
  };
  const axisTick = { fontSize: 11, fill: "var(--chat-text-muted)" };
  const tooltipStyle = {
    background: "var(--chat-surface)",
    border: "1px solid var(--chat-border-strong)",
    borderRadius: 6,
    fontSize: 12,
    color: "var(--chat-text)",
  };
  // The default Tooltip cursor (a bright guide line/rect) reads as a stray
  // white line against the dark theme — the point marker + tooltip already
  // carry the hover feedback, so drop the cursor overlay entirely.
  const cursor = false;

  // Click a point → "what happened here?"; drag → "what happened over this
  // interval?". recharts v3 clears the active point on click, so we track the
  // hovered bucket index on mouse-move and read it on mouse-up. A quick
  // press-release on one bucket is a point; a drag across buckets is an
  // interval.
  const normIndex = (v: number | string | null | undefined): number | null => {
    const n = typeof v === "string" ? Number(v) : v;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
  };
  const idxFromState = (state: ChartMouseState): number | null =>
    normIndex(state?.activeTooltipIndex) ?? normIndex(state?.activeIndex);

  const handleChartMouseDown = (state: ChartMouseState) => {
    if (!onAsk) return;
    const idx = idxFromState(state);
    if (idx == null) return;
    draggingRef.current = true;
    dragStartRef.current = idx;
    dragEndRef.current = idx;
    setSelected(null);
    setSelectedInterval(null);
    setDragHighlight({ x1: rows[idx].t, x2: rows[idx].t });
  };
  const handleChartMouseMove = (state: ChartMouseState) => {
    const idx = idxFromState(state);
    hoverIndexRef.current = idx;
    if (draggingRef.current && idx != null) {
      dragEndRef.current = idx;
      const lo = Math.min(dragStartRef.current ?? idx, idx);
      const hi = Math.max(dragStartRef.current ?? idx, idx);
      setDragHighlight({ x1: rows[lo].t, x2: rows[hi].t });
    }
  };
  const cancelDrag = () => {
    draggingRef.current = false;
    setDragHighlight(null);
  };
  const handleChartMouseUp = () => {
    if (!onAsk || !draggingRef.current) return;
    draggingRef.current = false;
    setDragHighlight(null);
    const a = dragStartRef.current;
    const b = dragEndRef.current;
    if (a == null || b == null || !rows[a] || !rows[b]) return;
    if (a === b) {
      const row = rows[a];
      const items = seriesNames
        .map((name) => ({ name, value: row[name] }))
        .filter(
          (i): i is { name: string; value: number } =>
            typeof i.value === "number" && Number.isFinite(i.value),
        );
      setSelected({ t: row.t, items });
    } else {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      setSelectedInterval({ t1: rows[lo].t, t2: rows[hi].t });
    }
  };

  const roundVal = (v: number) => Math.round(v * 100) / 100;
  const askAboutSelected = () => {
    if (!onAsk || !selected) return;
    const whenStr = new Date(selected.t).toLocaleString();
    const vals = selected.items
      .map((i) => `${i.name} = ${roundVal(i.value)}${unit ? ` ${unit}` : ""}`)
      .join(", ");
    const when = vals ? `${whenStr} — ${vals}` : whenStr;
    onAsk(fillTemplate(t.questionPointTemplate, { title: chart.title, when }));
    setSelected(null);
  };
  const askAboutInterval = () => {
    if (!onAsk || !selectedInterval) return;
    const from = new Date(selectedInterval.t1).toLocaleString();
    const to = new Date(selectedInterval.t2).toLocaleString();
    onAsk(
      fillTemplate(t.questionIntervalTemplate, { title: chart.title, from, to }),
    );
    setSelectedInterval(null);
  };

  // "Normal range" band (AI-analysed p5–p95) — shaded behind the line so a
  // value reads as normal/high/low at a glance. Only for a SINGLE series (or
  // a combine:"sum" line); with several metrics overlaid the bands would
  // differ and clutter, so we skip it. ifOverflow="extendDomain" keeps the
  // band visible even when current values sit entirely outside it (the whole
  // point of "am I below normal?").
  const singleBand = seriesNames.length === 1 ? chart.series[0].band : null;
  const bandP5 = singleBand?.p5 ?? null;
  const bandP95 = singleBand?.p95 ?? null;
  const renderNormalBand = () => {
    if (bandP5 != null && bandP95 != null && bandP5 !== bandP95) {
      return (
        <ReferenceArea
          y1={Math.min(bandP5, bandP95)}
          y2={Math.max(bandP5, bandP95)}
          fill="var(--chat-text-muted)"
          fillOpacity={0.12}
          stroke="none"
          ifOverflow="extendDomain"
          label={{
            value: "typical range",
            position: "insideTopRight",
            fontSize: 10,
            fill: "var(--chat-text-muted)",
          }}
        />
      );
    }
    const single = bandP5 ?? bandP95;
    if (single != null) {
      return (
        <ReferenceLine
          y={single}
          stroke="var(--chat-text-muted)"
          strokeDasharray="4 4"
          strokeOpacity={0.5}
          ifOverflow="extendDomain"
        />
      );
    }
    return null;
  };

  // Axes/tooltip/legend are identical across chart types — build once and
  // spread into whichever chart wrapper renders (recharts flattens arrays of
  // children and detects each by type).
  const margin = { top: 8, right: 12, bottom: 4, left: 4 };
  const bandEl = renderNormalBand();
  // Live interval-drag highlight (a vertical band across the picked x-range).
  const dragEl = dragHighlight ? (
    <ReferenceArea
      x1={dragHighlight.x1}
      x2={dragHighlight.x2}
      fill="var(--chat-accent, #3b82f6)"
      fillOpacity={0.15}
      stroke="none"
    />
  ) : null;
  const axisEls = [
    <XAxis
      key="x"
      dataKey="t"
      type="number"
      scale="time"
      domain={["dataMin", "dataMax"]}
      tickFormatter={tickFormatter}
      tick={axisTick}
      minTickGap={24}
    />,
    <YAxis key="y" tickFormatter={yTickFormatter} tick={axisTick} width={64} />,
    <Tooltip key="tt" cursor={cursor} labelFormatter={labelFormatter} contentStyle={tooltipStyle} />,
    seriesNames.length > 1 ? (
      <Legend key="lg" wrapperStyle={{ fontSize: 11 }} />
    ) : null,
  ];

  // Event markers (mark_events): dashed vertical lines at each step change —
  // green for a refill/step-up, red for a big draw/step-down.
  const annotationEls = (chart.annotations ?? [])
    .map((a, i) => {
      const x = Date.parse(a.t);
      if (Number.isNaN(x)) return null;
      const color =
        a.kind === "down"
          ? "var(--color-error, #f87171)"
          : "var(--color-success, #4ade80)";
      return (
        <ReferenceLine
          key={`ann-${i}`}
          x={x}
          stroke={color}
          strokeDasharray="3 3"
          strokeOpacity={0.7}
          label={{
            value: a.label,
            position: "insideTop",
            fontSize: 9,
            fill: color,
          }}
        />
      );
    })
    .filter(Boolean);

  return (
    <div className="chat-chart">
      <div className="chat-chart__canvas">
        <ResponsiveContainer width="100%" height={260}>
          {chart.kind === "area" ? (
            <AreaChart data={rows} margin={margin} onMouseDown={handleChartMouseDown} onMouseMove={handleChartMouseMove} onMouseUp={handleChartMouseUp} onMouseLeave={cancelDrag}>
              {bandEl}
              {dragEl}
              {axisEls}
              {annotationEls}
              {seriesNames.map((name, i) => {
                const color = SERIES_COLORS[i % SERIES_COLORS.length];
                return (
                  <Area
                    key={name}
                    type="monotone"
                    dataKey={name}
                    stackId="1"
                    stroke={color}
                    fill={color}
                    fillOpacity={0.45}
                    connectNulls
                    isAnimationActive={false}
                  />
                );
              })}
            </AreaChart>
          ) : chart.kind === "bar" ? (
            <BarChart data={rows} margin={margin} onMouseDown={handleChartMouseDown} onMouseMove={handleChartMouseMove} onMouseUp={handleChartMouseUp} onMouseLeave={cancelDrag}>
              {bandEl}
              {dragEl}
              {axisEls}
              {annotationEls}
              {seriesNames.map((name, i) => (
                <Bar
                  key={name}
                  dataKey={name}
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                />
              ))}
            </BarChart>
          ) : (
            <LineChart data={rows} margin={margin} onMouseDown={handleChartMouseDown} onMouseMove={handleChartMouseMove} onMouseUp={handleChartMouseUp} onMouseLeave={cancelDrag}>
              {bandEl}
              {dragEl}
              {axisEls}
              {annotationEls}
              {seriesNames.map((name, i) => (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  strokeDasharray={chart.series[i]?.dashed ? "6 4" : undefined}
                  dot={false}
                  strokeWidth={2}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>

      {onAsk && selected && (
        <div className="chat-chart__ask">
          <span className="chat-chart__ask-label">
            {new Date(selected.t).toLocaleString()}
            {selected.items.length > 0 && (
              <>
                {" — "}
                {selected.items
                  .map((i) => `${roundVal(i.value)}${unit ? ` ${unit}` : ""}`)
                  .join(", ")}
              </>
            )}
          </span>
          <button
            type="button"
            className="chat-chart__ask-btn"
            onClick={askAboutSelected}
          >
            {t.askPoint}
          </button>
          <button
            type="button"
            className="chat-chart__ask-dismiss"
            onClick={() => setSelected(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {onAsk && selectedInterval && (
        <div className="chat-chart__ask">
          <span className="chat-chart__ask-label">
            {new Date(selectedInterval.t1).toLocaleString()} —{" "}
            {new Date(selectedInterval.t2).toLocaleString()}
          </span>
          <button
            type="button"
            className="chat-chart__ask-btn"
            onClick={askAboutInterval}
          >
            {t.askInterval}
          </button>
          <button
            type="button"
            className="chat-chart__ask-dismiss"
            onClick={() => setSelectedInterval(null)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
