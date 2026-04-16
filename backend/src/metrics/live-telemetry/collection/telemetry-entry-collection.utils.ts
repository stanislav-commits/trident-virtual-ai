import type { ShipTelemetryEntry } from '../live-telemetry.types';

export function uniqueTelemetryEntries(
  entries: ShipTelemetryEntry[],
): ShipTelemetryEntry[] {
  const selected: ShipTelemetryEntry[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.key)) {
      continue;
    }

    selected.push(entry);
    seen.add(entry.key);
  }

  return selected;
}
