import type { ShipTelemetryEntry } from '../live-telemetry/live-telemetry.types';
import { buildTelemetryHaystack } from '../live-telemetry/telemetry-entry-text.utils';

export type HistoricalMetricSemanticKind =
  | 'counter'
  | 'coordinate'
  | 'state'
  | 'gauge';

export function getHistoricalMetricSemanticKind(
  entry: ShipTelemetryEntry,
): HistoricalMetricSemanticKind {
  const haystack = buildTelemetryHaystack(entry);
  if (
    /\b(latitude|longitude|lat|lon|position|gps|coordinate)\b/i.test(haystack)
  ) {
    return 'coordinate';
  }

  if (
    entry.dataType === 'boolean' ||
    /\b(status|state|alarm|fault)\b/i.test(haystack)
  ) {
    return 'state';
  }

  if (
    /\b(total fuel used|fuel used|running hours|engine hours|hour meter|runtime|cumulative|counter|accumulated)\b/i.test(
      haystack,
    )
  ) {
    return 'counter';
  }

  return 'gauge';
}
