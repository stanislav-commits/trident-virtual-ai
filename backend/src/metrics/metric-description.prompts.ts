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
