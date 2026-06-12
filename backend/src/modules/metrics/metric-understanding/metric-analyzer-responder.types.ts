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

export interface AnswerQuestionResult {
  shipId: string;
  question: string;
  answer: string;
  toolCalls: ToolCallAudit[];        // query_metric calls (kept verbatim)
  otherToolCalls: OtherToolCallAudit[]; // lookup_asset / find_asset_metrics / list_assets_by_sfi
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
}
