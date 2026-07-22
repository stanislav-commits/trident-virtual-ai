import { useMemo } from "react";
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
import type { ChatChartDto } from "../../types/chat";

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

export default function ChatChartBlock({ chart }: { chart: ChatChartDto }) {
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
            <AreaChart data={rows} margin={margin}>
              {bandEl}
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
            <BarChart data={rows} margin={margin}>
              {bandEl}
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
            <LineChart data={rows} margin={margin}>
              {bandEl}
              {axisEls}
              {annotationEls}
              {seriesNames.map((name, i) => (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
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
    </div>
  );
}
