import { useMemo } from "react";
import {
  Bar,
  BarChart,
  Legend,
  Line,
  LineChart,
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

  return (
    <div className="chat-chart">
      <div className="chat-chart__canvas">
        <ResponsiveContainer width="100%" height={260}>
          {chart.kind === "bar" ? (
            <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={tickFormatter}
                tick={axisTick}
                minTickGap={24}
              />
              <YAxis tickFormatter={yTickFormatter} tick={axisTick} width={64} />
              <Tooltip cursor={cursor} labelFormatter={labelFormatter} contentStyle={tooltipStyle} />
              {seriesNames.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
              {seriesNames.map((name, i) => (
                <Bar
                  key={name}
                  dataKey={name}
                  fill={SERIES_COLORS[i % SERIES_COLORS.length]}
                />
              ))}
            </BarChart>
          ) : (
            <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={tickFormatter}
                tick={axisTick}
                minTickGap={24}
              />
              <YAxis tickFormatter={yTickFormatter} tick={axisTick} width={64} />
              <Tooltip cursor={cursor} labelFormatter={labelFormatter} contentStyle={tooltipStyle} />
              {seriesNames.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
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
