import type { ShipTelemetryEntry } from '../live-telemetry.types';
import { buildTelemetryHaystack } from '../telemetry-entry-text.utils';
import { normalizeTelemetryText } from '../telemetry-text.utils';

export type TelemetryCoordinateKind = 'latitude' | 'longitude';

export function getTelemetryCoordinateKinds(
  entry: ShipTelemetryEntry,
): Set<TelemetryCoordinateKind> {
  const kinds = new Set<TelemetryCoordinateKind>();
  const haystack = buildTelemetryHaystack(entry);

  if (/\b(latitude|lat)\b/i.test(haystack)) {
    kinds.add('latitude');
  }
  if (/\b(longitude|lon)\b/i.test(haystack)) {
    kinds.add('longitude');
  }

  return kinds;
}

export function getExplicitTelemetryCoordinateKinds(
  entry: ShipTelemetryEntry,
): Set<TelemetryCoordinateKind> {
  const exactText = normalizeTelemetryText(
    [entry.key, entry.label, entry.field].filter(Boolean).join(' '),
  );
  const kinds = new Set<TelemetryCoordinateKind>();

  if (/\b(latitude|lat)\b/i.test(exactText)) {
    kinds.add('latitude');
  }
  if (/\b(longitude|lon)\b/i.test(exactText)) {
    kinds.add('longitude');
  }

  return kinds;
}

export function hasCoordinatePair(
  entries: ShipTelemetryEntry[],
  getKinds: (entry: ShipTelemetryEntry) => Set<TelemetryCoordinateKind>,
): boolean {
  const kinds = new Set<TelemetryCoordinateKind>();
  for (const entry of entries) {
    for (const kind of getKinds(entry)) {
      kinds.add(kind);
    }
    if (kinds.has('latitude') && kinds.has('longitude')) {
      return true;
    }
  }

  return false;
}
