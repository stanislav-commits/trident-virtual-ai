import type { ShipTelemetryEntry } from './live-telemetry.types';
import { humanizeMetricDisplayName } from '../metric-display-name.utils';
import { normalizeTelemetryText } from './telemetry-text.utils';

export function getPreferredTelemetryLabel(entry: ShipTelemetryEntry): string {
  const rawLabel =
    entry.measurement && entry.field
      ? `${entry.measurement}.${entry.field}`
      : null;
  const normalizedLabel = entry.label?.trim() ?? '';

  const fallbackLabel =
    entry.field?.trim() ||
    normalizedLabel ||
    entry.key.split('::').slice(-1)[0]?.trim() ||
    entry.key;
  const preferredLabel =
    normalizedLabel && normalizedLabel !== rawLabel ? normalizedLabel : fallbackLabel;

  return humanizeMetricDisplayName(preferredLabel);
}

export function buildTelemetryHaystack(entry: ShipTelemetryEntry): string {
  return normalizeTelemetryText(
    [
      getPreferredTelemetryLabel(entry),
      entry.bucket,
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
      getPreferredTelemetryLabel(entry),
      entry.bucket,
      entry.field,
      entry.unit,
    ]
      .filter(Boolean)
      .join(' '),
  );
}
