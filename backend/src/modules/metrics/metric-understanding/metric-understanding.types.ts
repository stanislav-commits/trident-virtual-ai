/**
 * Shape of one LLM-produced analysis for a single metric. Mirrors the
 * structure we settled on during the Ruby PoC (engines batch, 92/92 OK).
 */
export interface MetricAnalysisJson {
  description: string;
  kind: 'gauge' | 'counter' | 'rate' | 'state';
  unit: string;
  unit_confidence: number;
  bound_asset_id: string; // asset_id_internal from the shortlist, or 'NONE'
  bound_asset_confidence: number;
  questions_can_answer: string[];
  warnings: string[];
  reasoning: string;
}

/** Statistical fingerprint pulled from Influx and fed into the LLM bundle. */
export interface MetricFingerprint {
  count: number;
  min: number;
  p5: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
  is_monotonic: boolean;
  non_zero_share_pct: number;
}

/** Asset candidate shortlisted by the keyword pre-filter. */
export interface AssetCandidate {
  asset_id_internal: string;
  display_name: string;
  sfi_sub_name: string | null;
  brand: string | null;
  model: string | null;
  location: string | null;
}

export interface AnalyzeShipOptions {
  // If true (default) skip metrics that already have `ai_generated_at`.
  onlyMissing?: boolean;
  // Restrict to a single measurement (helps iterate on tuning).
  measurement?: string;
  // Concurrency cap for parallel LLM calls.
  concurrency?: number;
  // Hard upper bound (safety against accidentally analyzing 100K metrics).
  maxMetrics?: number;
  // If true, the endpoint returns immediately after the run starts; the
  // caller polls `GET /analyze/progress` for status. Default false.
  background?: boolean;
}

export interface AnalyzeShipKickoffResult {
  shipId: string;
  started: boolean;
  totalQueued: number;
  message: string;
}

export interface AnalyzeShipResult {
  shipId: string;
  totalConsidered: number;
  analyzed: number;
  skippedNoData: number;
  failedLlm: number;
  failedParse: number;
  durationMs: number;
  estimatedCostUsd: number;
}

export interface AnalyzeOneResult {
  metricId: string;
  status: 'analyzed' | 'no_data' | 'llm_failed' | 'parse_failed';
  analysis?: MetricAnalysisJson;
  fingerprint?: MetricFingerprint;
  durationMs: number;
  errorMessage?: string;
}
