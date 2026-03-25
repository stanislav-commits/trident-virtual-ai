import type { InfluxMetric } from '../influxdb/influxdb.service';

export interface MetricDescriptionPrompt {
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
}

export function buildMetricDescriptionPrompt(
  metric: InfluxMetric,
): MetricDescriptionPrompt {
  return {
    systemPrompt:
      'You write concise telemetry metric descriptions for marine dashboards. ' +
      'Use only the provided key, bucket, measurement, field, and label. ' +
      'Treat bucket and measurement as grouping context only; prefer field and label when they conflict. ' +
      'Do not infer temperature, pressure, level, status, or alarms from a grouping name alone. ' +
      'If the field or label looks like a dedicated tank identifier such as Fuel_Tank_1P, describe it as a tank reading unless the field or label explicitly says temperature. ' +
      'Do not mention Grafana, OpenAI, InfluxDB, databases, or AI. ' +
      'Do not overclaim when meaning is unclear. ' +
      'Return plain text only, one short sentence, ideally 8-18 words.',
    userPrompt: JSON.stringify({
      key: metric.key,
      bucket: metric.bucket,
      measurement: metric.measurement,
      field: metric.field,
      label: metric.label,
    }),
    temperature: 0.2,
    maxTokens: 80,
  };
}

export function normalizeMetricDescriptionResponse(
  value: string | null | undefined,
): string | null {
  if (!value?.trim()) {
    return null;
  }

  const singleLine = value
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '');

  if (!singleLine) {
    return null;
  }

  const firstSentence =
    singleLine.match(/^(.{1,180}?[.!?])(?:\s|$)/)?.[1]?.trim() ?? singleLine;
  const normalized = firstSentence.replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return null;
  }

  if (normalized.length <= 180) {
    return normalized;
  }

  return `${normalized.slice(0, 177).trimEnd()}...`;
}
