import type { ShipTelemetryEntry } from '../live-telemetry.types';

export function getTelemetryDisplayUnit(entry: ShipTelemetryEntry): string | null {
  const explicitUnit = entry.unit?.trim();
  if (explicitUnit) {
    return normalizeTelemetryDisplayUnit(explicitUnit);
  }

  const sourceText = `${entry.field ?? ''} ${entry.label ?? ''}`.trim();
  if (!sourceText) {
    return null;
  }

  if (/%/.test(sourceText)) {
    return '%';
  }

  const match = sourceText.match(/\(([^)]+)\)/);
  if (!match?.[1]) {
    return null;
  }

  return normalizeTelemetryDisplayUnit(match[1]);
}

export function getConsistentTelemetryDisplayUnit(
  entries: ShipTelemetryEntry[],
): string | null {
  const units = [
    ...new Set(entries.map((entry) => getTelemetryDisplayUnit(entry)).filter(Boolean)),
  ];
  if (units.length !== 1) {
    return null;
  }

  const [unit] = units;
  if (!unit) {
    return null;
  }

  return unit;
}

export function normalizeTelemetryDisplayUnit(unit: string): string | null {
  const trimmed = unit.trim();
  if (!trimmed) {
    return null;
  }

  if (/^l$/i.test(trimmed) || /^lit(er|re)s?$/i.test(trimmed)) {
    return 'liters';
  }

  if (/%/.test(trimmed)) {
    return '%';
  }

  if (/^kw$/i.test(trimmed)) {
    return 'kW';
  }

  if (/^nm$/i.test(trimmed)) {
    return 'Nm';
  }

  if (/^rpm$/i.test(trimmed)) {
    return 'rpm';
  }

  if (/^c$|^\u00b0c$/i.test(trimmed)) {
    return '\u00b0C';
  }

  return trimmed;
}
