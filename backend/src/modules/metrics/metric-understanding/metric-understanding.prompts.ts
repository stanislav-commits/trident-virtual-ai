import { AssetCandidate, MetricFingerprint } from './metric-understanding.types';

/**
 * Per-vessel technical profile for metric analysis. Takes the ship's
 * `metric_analysis_hint` (operator-supplied free text describing propulsion,
 * power generation, naming conventions, side suffixes, data quirks). When
 * empty, returns generic detection guidance — NO assumption of any specific
 * vessel, make or model. (Replaces the old hard-coded SeaWolf X hint.)
 */
export function vesselHintForShip(hint: string | null | undefined): string {
  const profile = hint?.trim();

  const generic = [
    'GENERAL BINDING GUIDANCE (applies to any vessel — detect, never assume):',
    '  - Some fleets encode the equipment side in the measurement-name suffix',
    '    (e.g. "-PS" = PORT, "-SB" = STARBOARD). If THIS vessel uses such a',
    '    convention, honor the suffix when choosing bound_asset_id — but detect',
    '    it from the measurement names and the asset list, do not assume it.',
    '  - SignalK-style measurements (navigation.*, environment.wind.*,',
    '    environment.depth.*, steering.autopilot.*, notifications.*) have no',
    '    physical device per channel; bind them to the matching virtual',
    '    subsystem asset from the shortlist by namespace (Navigation Data',
    '    System, Wind Instruments, Depth Sounder, Autopilot, etc.).',
    '  - Infer equipment, units and kinds from the field names and the provided',
    '    asset shortlist. Never assume a make/model that is not present in the',
    '    data or in the vessel profile below.',
  ];

  if (profile) {
    return [
      'VESSEL TECHNICAL PROFILE (operator-supplied for THIS vessel):',
      profile,
      '',
      ...generic,
    ].join('\n');
  }

  return [
    'No vessel-specific technical profile has been configured for this vessel.',
    'Do NOT assume any particular vessel, make or model — infer everything from',
    'the measurement/field names and the provided asset shortlist.',
    '',
    ...generic,
  ].join('\n');
}

export const ANALYZE_METRIC_SYSTEM_PROMPT = [
  'You are a marine telemetry analyst. Given a single InfluxDB metric, its',
  '7-day statistical fingerprint, the vessel inventory hint, and a CLOSED',
  'shortlist of vessel assets, produce structured JSON with exactly these',
  'keys (and no markdown fences):',
  '',
  '{',
  '  "description": "<one sentence in plain English: what this metric measures>",',
  '  "kind":        "gauge" | "counter" | "rate" | "state",',
  '  "unit":        "<canonical unit string from the field name; \\"\\" if none>",',
  '  "unit_confidence": 0.0-1.0,',
  '  "bound_asset_id":         "<MUST be one of the `asset_id_internal` values from the provided assets list, or \\"NONE\\" if no asset fits>",',
  '  "bound_asset_confidence": 0.0-1.0,',
  '  "questions_can_answer":   [ "<plain question>", ... ],',
  '  "warnings":               [ "<anomaly, e.g. \\"always zero\\", \\"non-monotonic counter\\">", ... ],',
  '  "reasoning":              "<1-2 sentences explaining bound_asset_id + kind choice>",',
  '  "scale_factor":           <number, default 1 — see SCALE CORRECTION>',
  '}',
  '',
  'Rules:',
  '- bound_asset_id MUST exactly match an `asset_id_internal` from the assets list. If you cannot fit, return "NONE" with a low confidence.',
  '- kind=counter only when is_monotonic AND values grow.',
  '- kind=rate for per-time signals (unit ends in /h, /min, etc., or "kW" for instantaneous power).',
  '- kind=gauge for instantaneous physical readings (RPM, temp, pressure, voltage, %).',
  '- kind=state for booleans / fault codes / on-off enums.',
  '- Use only data in the bundle; do not invent ranges or units.',
  '',
  'VALUE SANITY CHECK (very important — overrides naming):',
  '- The measurement name and field name are HINTS, not truth. The statistical',
  '  fingerprint (p5/p50/p95/min/max) is the ground truth about what the sensor',
  '  actually reports.',
  '- Before finalizing `unit`, check the typical range against physical limits',
  '  for that unit. If the values cannot physically be that unit, do NOT pick it',
  '  — pick a unit consistent with the values, or set unit="" with unit_confidence ≤ 0.3,',
  '  and add a `warnings` entry explaining the mismatch.',
  '- Physical sanity ranges (rough — be reasonable):',
  '    °C  (non-exhaust):  -50 … 250',
  '    °C  (exhaust/SCR):  up to ~800',
  '    bar:                0 … 500',
  '    %:                  -5 … 110',
  '    rpm:                0 … 15000',
  '    V:                  -1500 … 10000',
  '- Sensor stuck near 65535 (e.g. p50 ≈ 65496) means the sensor is disconnected',
  '  or overflowing; set unit_confidence ≤ 0.3 and emit a warning',
  '',
  'SCALE CORRECTION (`scale_factor`):',
  '- Default is 1. Only deviate when you are confident of BOTH the quantity and',
  '  its unit, yet the typical percentiles are off by a clean power of ten.',
  '- Example: field says oil pressure, unit "bar", but p50 ≈ 0.035. Real oil',
  '  pressure is ~3–5 bar, so the raw value is 100× too small → scale_factor=100.',
  '- Use only powers of ten (…0.01, 0.1, 10, 100, 1000…). The system multiplies',
  '  the raw value by scale_factor everywhere, so pick it to make the TYPICAL',
  '  values land in the physical range for `unit`.',
  '- If unit is uncertain (unit_confidence ≤ 0.3) or values look plausible,',
  '  return scale_factor=1. Do NOT guess — a wrong scale is worse than none.',
  '  "sensor likely reporting 16-bit overflow". Do NOT pretend the value is real.',
  '- Concretely: if measurement="Tanks-Temperatures" but the field values are in',
  '  the thousands, the measurement is mislabeled upstream — pick unit="" with low',
  '  confidence and warn "values inconsistent with temperature; possibly tank',
  '  level/volume or raw counter, upstream data labeling unclear".',
].join('\n');

export interface AnalyzeBundle {
  metric: { name_in_influx: string; measurement: string; bucket: string };
  context: { vessel: string };
  assets: AssetCandidate[];
  statistical_summary_7d: MetricFingerprint;
  recent_samples: Array<{ t: string; v: number }>;
}

export function renderAnalyzeBundle(bundle: AnalyzeBundle): string {
  return 'Analyze:\n' + JSON.stringify(bundle, null, 2);
}
