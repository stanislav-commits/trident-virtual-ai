export interface MetricDescriptionInput {
  key: string;
  bucket: string;
  measurement: string;
  field: string;
  label: string;
  unit?: string | null;
}

export interface MetricDescriptionPrompt {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
}

export interface MetricEnrichmentResult {
  displayName: string | null;
  description: string | null;
}

export function buildMetricDescriptionPrompt(
  metric: MetricDescriptionInput,
): MetricDescriptionPrompt {
  return {
    systemPrompt:
      'You write helpful telemetry metric descriptions for a yacht operations platform. ' +
      'Use the provided key, bucket, measurement, field, label, and unit. ' +
      'Treat bucket and measurement as grouping context only; prefer field and label when they conflict. ' +
      'Do not infer alarms, limits, maintenance actions, or vessel-specific behavior from grouping names alone. ' +
      'If the field or label looks like a dedicated tank identifier such as Fuel_Tank_1P, describe it as a tank reading unless the field or label explicitly says temperature. ' +
      'If the metric name clearly maps to a well-known marine or navigation concept, especially an NMEA concept, you may explain that standard meaning in plain language and expand a widely known acronym once. ' +
      'If a unit is provided, include it. If no unit is provided, include a Unit line only when the unit is unambiguous from a widely established standard metric name. ' +
      'Do not mention Grafana, OpenAI, InfluxDB, databases, or AI. ' +
      'Do not overclaim when meaning is unclear; stay conservative for ambiguous metrics. ' +
      'Return plain text only using 2 or 3 short lines in this format: first line is a concise overview sentence, second line starts with "What it measures:", optional third line starts with "Unit:".',
    userPrompt: JSON.stringify({
      key: metric.key,
      bucket: metric.bucket,
      measurement: metric.measurement,
      field: metric.field,
      label: metric.label,
      unit: metric.unit ?? null,
    }),
    temperature: 0.2,
    maxTokens: 220,
  };
}

export function buildMetricEnrichmentPrompt(
  metric: MetricDescriptionInput,
): MetricDescriptionPrompt {
  return {
    systemPrompt:
      'You normalize telemetry metric metadata for a yacht operations platform. ' +
      'Use the raw key as the primary source of identity. Treat measurement and field as raw source fragments only. ' +
      'If the field is generic like value, status, or state, infer the human meaning from the raw key and measurement path. ' +
      'If the metric looks like a dedicated tank identifier such as Fuel_Tank_1P, produce a clean display name like Fuel Tank 1P unless the metadata clearly says temperature. ' +
      'Display names must remove raw grouping prefixes and unit suffixes such as liters, volts, or percent when they are not part of the object name itself. ' +
      'Return JSON only with exactly two keys: displayName and description. ' +
      'displayName must be concise, human-readable, and usually 1-6 words. ' +
      'description must be plain text only using 2 or 3 short lines in this format: first line is a concise overview sentence, second line starts with "What it measures:", optional third line starts with "Unit:". ' +
      'Do not mention Grafana, OpenAI, InfluxDB, databases, raw keys, source fields, or AI. ' +
      'Stay conservative when meaning is unclear.',
    userPrompt: JSON.stringify({
      key: metric.key,
      bucket: metric.bucket,
      measurement: metric.measurement,
      field: metric.field,
      label: metric.label,
      unit: metric.unit ?? null,
    }),
    temperature: 0.2,
    maxTokens: 260,
  };
}

export function normalizeMetricDescriptionResponse(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) {
    return null;
  }

  const structuredText = value
    .replace(/\r\n/g, '\n')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(
      /\s+(What it measures\s*:|Unit\s*:|Why it matters\s*:|Context\s*:)/gi,
      '\n$1',
    )
    .replace(/\n{3,}/g, '\n\n');

  if (!structuredText) {
    return null;
  }

  const normalizedLines = structuredText
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 4);

  if (normalizedLines.length === 0) {
    return null;
  }

  const normalized = normalizedLines.join('\n');
  if (normalized.length <= 480) {
    return normalized;
  }

  return `${normalized.slice(0, 477).trimEnd()}...`;
}

function stripMarkdownCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();
}

function normalizeMetricDisplayName(value: string | null | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }

  const normalized = value
    .replace(/\r\n/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();

  if (!normalized) {
    return null;
  }

  if (normalized.length <= 100) {
    return normalized;
  }

  return `${normalized.slice(0, 97).trimEnd()}...`;
}

export function normalizeMetricEnrichmentResponse(
  value: string | null | undefined,
): MetricEnrichmentResult {
  if (!value?.trim()) {
    return {
      displayName: null,
      description: null,
    };
  }

  const trimmed = stripMarkdownCodeFence(value);
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const candidate = jsonMatch?.[0] ?? trimmed;

  try {
    const parsed = JSON.parse(candidate) as {
      displayName?: string | null;
      description?: string | null;
    };

    return {
      displayName: normalizeMetricDisplayName(parsed.displayName),
      description: normalizeMetricDescriptionResponse(parsed.description),
    };
  } catch {
    return {
      displayName: null,
      description: normalizeMetricDescriptionResponse(trimmed),
    };
  }
}
