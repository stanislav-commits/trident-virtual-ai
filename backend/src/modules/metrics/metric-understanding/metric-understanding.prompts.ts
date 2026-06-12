import { AssetCandidate, MetricFingerprint } from './metric-understanding.types';

/**
 * Vessel naming convention hints. For now hard-coded for SeaWolf X — once
 * we have more than one vessel under management this should move onto the
 * ship entity as a `metric_analysis_hint` JSONB column.
 */
export function vesselHintForShip(_shipId: string): string {
  return [
    'Hybrid 50m motor yacht "SeaWolf X" (Rossinavi FR05).',
    'Propulsion: 2× Lucchi PM electric motors (port + starboard) driven by Siemens inverters; 2× alternators on the propulsion shafts.',
    'Power generation: 2× Siemens-controlled diesel gensets + 2× MASE VS350V auxiliary diesel gensets.',
    'DEF (AdBlue) tanks feed the MASE SCR systems.',
    '',
    'NAMING CONVENTION (CRITICAL — measurement-name suffix encodes the side):',
    '  Any Influx measurement ending in "-PS" = PORT side (left, facing forward).',
    '  Any Influx measurement ending in "-SB" = STARBOARD side (right, facing forward).',
    '  Examples:',
    '    SIEMENS-PROPULSION-PS  → port propulsion motor / inverter',
    '    SIEMENS-PROPULSION-SB  → starboard propulsion motor / inverter',
    '    SIEMENS-GENSET-PS      → port primary Siemens-controlled diesel genset',
    '    SIEMENS-GENSET-SB      → starboard primary Siemens-controlled diesel genset',
    '    SIEMENS-MASE-GENSET-PS → port MASE auxiliary diesel genset',
    '    SIEMENS-MASE-GENSET-SB → starboard MASE auxiliary diesel genset',
    'You MUST honor the side suffix when choosing bound_asset_id.',
    '',
    'UPSTREAM DATA QUIRKS (override what measurement-name suggests):',
    '  Influx measurement "Tanks-Temperatures" is mislabeled — the Fuel_Tank_*',
    '  fields under it report the TANK LEVEL IN LITERS (L), not temperature.',
    '  Treat these as kind=gauge, unit=L. Other fields under the same',
    '  measurement may still be actual temperatures — judge per field name.',
    '',
    'NAVIGATION / ENVIRONMENT SUBSYSTEM BINDINGS:',
    '  SignalK-style measurements have no physical device per channel; bind',
    '  to the appropriate virtual subsystem asset:',
    '    measurement starts with "navigation."   →  SWX.7.1.05  (Navigation Data System)',
    '    measurement starts with "environment.wind."   →  SWX.7.1.06  (Wind Instruments)',
    '    measurement starts with "environment.depth."  →  SWX.7.1.03  (Depth Sounder)',
    '    measurement starts with "steering.autopilot." →  SWX.7.1.04  (Autopilot)',
    '    measurement starts with "notifications."  →  the same subsystem',
    '      its inner path resembles (e.g. notifications.navigation.* → SWX.7.1.05).',
    '  Use confidence 0.9 for these bindings; the routing is by namespace.',
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
  '  "reasoning":              "<1-2 sentences explaining bound_asset_id + kind choice>"',
  '}',
  '',
  'Rules:',
  '- bound_asset_id MUST exactly match an `asset_id_internal` from the assets list (e.g. "SWX.3.2.3.01-PS"). If you cannot fit, return "NONE" with a low confidence.',
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
