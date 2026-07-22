/**
 * Output of one tool_call → Influx execution round.
 */
export interface ToolCallAudit {
  iteration: number;
  measurement: string;
  field: string;          // the field the LLM asked for (may be fuzzy-resolved)
  resolvedField: string;  // the field actually executed
  aggregation: string;
  rangeStart: string;
  rangeStop?: string;
  value: number | null;
  ok: boolean;
  errorMessage?: string;
  latencyMs: number;
}

export interface OtherToolCallAudit {
  iteration: number;
  tool: string;            // e.g. 'lookup_asset', 'find_asset_metrics'
  args: Record<string, unknown>;
  ok: boolean;
  resultSummary: string;   // 1-line summary so the audit isn't huge
  errorMessage?: string;
  latencyMs: number;
}

/**
 * A time-series chart the analyzer built for the user to SEE (via the
 * `render_chart` tool). Accumulated out-of-band like `otherToolCalls` — the
 * series never goes back to the model (only a compact summary does), it rides
 * to the chat client on the message's `ragflowContext` and is drawn by the
 * frontend. One chart may overlay a few series (e.g. compare two metrics).
 */
export interface ChatChartSeriesPoint {
  /** ISO timestamp of the down-sampled bucket. */
  t: string;
  /** Scaled value (raw × scaleFactor), or null for an empty bucket. */
  v: number | null;
}

export interface ChatChartSeries {
  name: string;
  points: ChatChartSeriesPoint[];
  /** Rendered as a dashed line — used for the projected (forecast) trend so
   *  it reads as "estimate", not measured data. */
  dashed?: boolean;
  /**
   * The metric's "typical range" (AI-analysed p5–p95 percentiles, already
   * scaled to display units). The frontend draws it as a faint shaded band
   * so a value reads as normal/high/low at a glance. Only rendered for a
   * single-series chart (or a combine:'sum' line, where the band is the sum
   * of the contributing metrics' percentiles). null when unavailable.
   */
  band?: { p5: number | null; p95: number | null } | null;
}

/** A vertical event marker on the time axis (e.g. a bunkering / refill spotted
 *  as a step-up, or a large draw as a step-down). */
export interface ChatChartAnnotation {
  /** ISO timestamp on the X axis. */
  t: string;
  /** Short caption, e.g. "+3 200 L" (a refill) or "−1 100 L". */
  label: string;
  kind?: 'up' | 'down' | 'event';
}

export interface ChatChart {
  title: string;
  unit: string | null;
  /** line = trends; bar = per-period totals; area = STACKED composition
   *  (each series stacks, the top of the stack is the total). */
  kind: 'line' | 'bar' | 'area';
  series: ChatChartSeries[];
  /** Event markers drawn as dashed vertical lines (mark_events). */
  annotations?: ChatChartAnnotation[];
}

/** One point of the vessel's GPS track. */
export interface ChatMapTrackPoint {
  /** ISO timestamp. */
  t: string;
  lat: number;
  lon: number;
}

/**
 * A map the analyzer built for the user to SEE (render_map): the vessel's
 * GPS track over a period + current position, drawn client-side on an
 * interactive Windy map with weather layers. Rides on `ragflowContext` like
 * charts do.
 */
export interface ChatMap {
  title: string;
  /** Chronological track points (down-sampled). May be empty if no fix. */
  track: ChatMapTrackPoint[];
  /** Most recent fix (usually the last track point), or null. */
  current: ChatMapTrackPoint | null;
  /** Default Windy weather overlay, e.g. 'wind' | 'waves' | 'currents' |
   *  'pressure' | 'temp' | 'rain'. */
  weatherLayer: string;
}

export interface AnswerQuestionResult {
  shipId: string;
  question: string;
  answer: string;
  toolCalls: ToolCallAudit[];        // query_metric calls (kept verbatim)
  otherToolCalls: OtherToolCallAudit[]; // lookup_asset / find_asset_metrics / list_assets_by_sfi
  charts: ChatChart[];               // render_chart output, drawn client-side
  maps: ChatMap[];                   // render_map output, drawn client-side
  totalTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  iterations: number;
  hitTurnLimit: boolean;
}

export interface AnalyzedCatalogItem {
  metricId: string;
  measurement: string;
  field: string;
  bucket: string;
  description: string | null;
  kind: string | null;
  unit: string | null;
  boundAssetIdInternal: string | null;
  boundAssetName: string | null;
  typicalP5: number | null;
  typicalP50: number | null;
  typicalP95: number | null;
  nonZeroSharePct: number | null;
  isMonotonic: boolean | null;
  /** Raw→display multiplier; already applied to typical percentiles above. */
  scaleFactor: number;
}
