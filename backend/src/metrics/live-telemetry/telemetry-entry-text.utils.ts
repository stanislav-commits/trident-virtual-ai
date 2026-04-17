import type { ShipTelemetryEntry } from './live-telemetry.types';
import { normalizeTelemetryText } from './telemetry-text.utils';

export function buildTelemetryHaystack(entry: ShipTelemetryEntry): string {
  return normalizeTelemetryText(
    [
      entry.key,
      entry.label,
      entry.bucket,
      entry.measurement,
      entry.field,
      entry.description,
      entry.unit,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

export function buildTelemetryIdentityHaystack(
  entry: ShipTelemetryEntry,
): string {
  return normalizeTelemetryText(
    [
      entry.key,
      entry.label,
      entry.bucket,
      entry.measurement,
      entry.field,
      entry.unit,
    ]
      .filter(Boolean)
      .join(' '),
  );
}
