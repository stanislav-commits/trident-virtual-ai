import type { InfluxMetricValue } from '../../influxdb/influxdb.service';
import { buildTelemetrySuggestionLabel } from '../live-telemetry/rendering/telemetry-clarification-renderer';
import { getTelemetryDisplayUnit } from '../live-telemetry/rendering/telemetry-display-unit.utils';
import type { ShipTelemetryEntry } from '../live-telemetry/live-telemetry.types';
import type { ParsedHistoricalTelemetryRequest } from './historical-telemetry-query-parser';
import {
  formatAggregateNumber,
  parseHistoricalNumericValue,
} from './historical-telemetry.utils';
import { normalizeTelemetryText } from '../live-telemetry/telemetry-text.utils';

export interface HistoricalCoordinatePair {
  latitude: number;
  longitude: number;
  time: Date;
}

export function buildHistoricalClarificationActions(
  entries: ShipTelemetryEntry[],
  request: ParsedHistoricalTelemetryRequest,
): Array<{ label: string; message: string; kind?: 'suggestion' | 'all' }> {
  const selected: Array<{
    label: string;
    message: string;
    kind?: 'suggestion' | 'all';
  }> = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const label = buildTelemetrySuggestionLabel(entry);
    const normalizedLabel = normalizeTelemetryText(label);
    if (!label || seen.has(normalizedLabel)) {
      continue;
    }

    seen.add(normalizedLabel);
    selected.push({
      label,
      message:
        request.operation === 'point' || request.operation === 'position'
          ? `What was ${label} at ${request.rangeLabel}?`
          : `What was ${label} during ${request.rangeLabel}?`,
      kind: 'suggestion',
    });

    if (selected.length >= 4) {
      break;
    }
  }

  return selected;
}

export function formatHistoricalMetricValue(
  entry: ShipTelemetryEntry,
  value: unknown,
): string {
  const numericValue = parseHistoricalNumericValue(value);
  if (numericValue == null) {
    return typeof value === 'string' ? value : 'unavailable';
  }

  const unit = getTelemetryDisplayUnit(entry);
  return `${formatAggregateNumber(numericValue)}${unit ? ` ${unit}` : ''}`;
}

export function extractHistoricalCoordinatePair(
  rows: InfluxMetricValue[],
): HistoricalCoordinatePair | null {
  const latitudeRow = rows.find((row) => /\b(lat|latitude)\b/i.test(row.field));
  const longitudeRow = rows.find((row) =>
    /\b(lon|longitude)\b/i.test(row.field),
  );

  if (!latitudeRow || !longitudeRow) {
    return null;
  }

  const latitude = parseHistoricalNumericValue(latitudeRow.value);
  const longitude = parseHistoricalNumericValue(longitudeRow.value);
  const latitudeTime = Date.parse(latitudeRow.time);
  const longitudeTime = Date.parse(longitudeRow.time);
  if (
    latitude == null ||
    longitude == null ||
    !Number.isFinite(latitudeTime) ||
    !Number.isFinite(longitudeTime)
  ) {
    return null;
  }

  return {
    latitude,
    longitude,
    time: new Date(Math.max(latitudeTime, longitudeTime)),
  };
}

export function isSameCoordinateArea(
  left: { latitude: number; longitude: number },
  right: { latitude: number; longitude: number },
): boolean {
  return (
    Math.abs(left.latitude - right.latitude) <= 0.0005 &&
    Math.abs(left.longitude - right.longitude) <= 0.0005
  );
}

export function getHistoricalPositiveDeltaThreshold(
  entry: ShipTelemetryEntry,
): number {
  const unit = getTelemetryDisplayUnit(entry);
  if (unit === '%') {
    return 1;
  }

  return 20;
}
