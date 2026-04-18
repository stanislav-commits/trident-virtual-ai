import {
  hasNonNavigationPrimarySpeedSubject,
  hasTelemetryNavigationPositionContext,
  isNavigationHeadingIntent,
  isNavigationLocationIntent,
  isNavigationSpeedIntent,
} from '../query/telemetry-navigation-query.utils';
import { isElectricalCurrentQuery } from '../query/telemetry-query-context.utils';
import { normalizeTelemetryText } from '../telemetry-text.utils';
import { detectStoredFluidSubject } from './stored-fluid-subject.utils';

export function extractTelemetryMeasurementKinds(value: string): Set<string> {
  const kinds = new Set<string>();
  const normalized = normalizeTelemetryText(value);
  const inventoryContextBlocked =
    /\b(used|consumed|consumption|usage|rate|flow|pressure|temp(?:erature)?|voltage|power|energy|frequency|status|state|alarm|warning|fault|trip)\b/i.test(
      normalized,
    );
  const hasTankOrFluidContext =
    /\btank\b/i.test(normalized) ||
    /\b(fuel|oil|coolant|water|def|urea|adblue)\b/i.test(normalized);
  const hasInventoryContext =
    hasTankOrFluidContext ||
    /\b(volume|quantity|contents?|remaining|available|onboard|capacity)\b/i.test(
      normalized,
    ) ||
    /\b(l|lt|ltr|liters?|litres?|percent|percentage|%|gal|gallons?|m3|m 3)\b/i.test(
      normalized,
    );
  const mentionsNonInventoryLevel =
    /\b(voltage|current|power|signal|frequency|sound|audio|noise)\s+levels?\b/i.test(
      normalized,
    ) ||
    /\blevels?\s+of\s+(voltage|current|power|signal|frequency|sound|audio|noise)\b/i.test(
      normalized,
    );
  const checks: Array<[RegExp, string]> = [
    [/\b(temp(?:eratures?)?|temps?)\b/i, 'temperature'],
    [/\b(pressures?)\b/i, 'pressure'],
    [/\b(voltages?|volts?)\b/i, 'voltage'],
    [/\b(currents?|amperage|amps?)\b/i, 'current'],
    [/\b(loads?)\b/i, 'load'],
    [/\b(power|powers?|watts?|kilowatts?|megawatts?|kw|mw)\b/i, 'power'],
    [
      /\b(energies?|watt\s*hours?|kilowatt\s*hours?|megawatt\s*hours?|wh|kwh|mwh)\b/i,
      'energy',
    ],
    [/\b(rpms?|speeds?|pace)\b/i, 'speed'],
    [
      /\b(heading|headings|heading\s+true|heading\s+magnetic|course\s+over\s+ground|cog)\b/i,
      'heading',
    ],
    [/\b(flows?|rates?)\b/i, 'flow'],
    [/\b(runtime|runtimes|running|hours?|hour\s*meter)\b/i, 'hours'],
    [
      /\b(status(?:es)?|state(?:s)?|alarms?|warnings?|faults?|trips?)\b/i,
      'status',
    ],
  ];

  for (const [pattern, label] of checks) {
    if (pattern.test(value)) {
      kinds.add(label);
    }
  }

  if (
    /\b(latitude|longitude|coordinates?|gps|location|whereabouts|lat|lon)\b/i.test(
      normalized,
    ) ||
    /\bwhere\s+(?:are\s+we|am\s+i)\b/i.test(normalized) ||
    (/\bposition\b/i.test(normalized) &&
      hasTelemetryNavigationPositionContext(normalized))
  ) {
    kinds.add('location');
  }

  if (
    /\b(levels?)\b/i.test(normalized) &&
    (!mentionsNonInventoryLevel || hasInventoryContext) &&
    !inventoryContextBlocked
  ) {
    kinds.add('level');
  }

  const asksForStoredQuantity =
    /\b(how much|how many|onboard|remaining|left|available)\b/i.test(
      normalized,
    ) &&
    /\b(fuel|oil|coolant|water|tank|def|urea)\b/i.test(normalized) &&
    !/\b(used|consumed|consumption|rate|flow)\b/i.test(normalized);
  if (asksForStoredQuantity) {
    kinds.add('level');
  }

  if (
    /\b(volume|quantity|contents?)\b/i.test(normalized) &&
    !inventoryContextBlocked
  ) {
    kinds.add('level');
  }

  const looksLikeTankQuantity =
    /\btank\b/i.test(normalized) &&
    /\b(fuel|oil|coolant|water|def|urea)\b/i.test(normalized) &&
    (/\b(l|lt|ltr|liters?|litres?|gal|gallons?|m3|m 3)\b/i.test(
      normalized,
    ) ||
      /\b(volume|quantity|contents?|remaining|available|onboard)\b/i.test(
        normalized,
      )) &&
    !/\b(used|consumed|consumption|rate|flow|pressure|temp|temperature)\b/i.test(
      normalized,
    );
  if (looksLikeTankQuantity) {
    kinds.add('level');
  }

  const hasQuantityUnit =
    /\b(l|lt|ltr|liters?|litres?|percent|percentage|%|gal|gallons?|m3|m 3)\b/i.test(
      normalized,
    ) && !inventoryContextBlocked;
  if (hasQuantityUnit) {
    kinds.add('level');
  }

  return kinds;
}

export function extractTelemetryQueryMeasurementKinds(
  value: string,
): Set<string> {
  const kinds = extractTelemetryMeasurementKinds(value);
  const normalized = normalizeTelemetryText(value);
  if (isNavigationLocationIntent(normalized)) {
    kinds.add('location');
  }
  if (
    isNavigationSpeedIntent(normalized) &&
    !hasNonNavigationPrimarySpeedSubject(normalized)
  ) {
    kinds.add('speed');
  }
  if (isNavigationHeadingIntent(normalized)) {
    kinds.add('heading');
  }
  const fluid = detectStoredFluidSubject(normalized);
  const treatsCurrentAsLiveQualifier =
    kinds.has('current') &&
    !isElectricalCurrentQuery(normalized) &&
    ([...kinds].some((kind) => kind !== 'current') ||
      /\bcurrent\b\s+(value|values|reading|readings|status|state|metric|metrics|telemetry|signal|signals|level|levels|temperature|temperatures|pressure|pressures|voltage|voltages|power|powers|flow|flows|rate|rates|hours?|runtime)\b/i.test(
        normalized,
      ) ||
      /\b(now|right now|latest)\b/i.test(normalized) ||
      Boolean(fluid && /\btanks?\b/i.test(normalized)));

  if (treatsCurrentAsLiveQualifier) {
    kinds.delete('current');
  }

  if (
    /\b(active|inactive|enabled|disabled|running|stopped|open|closed|online|offline)\b/i.test(
      normalized,
    ) &&
    !/\b(power|energy|load|current|voltage|temperature|pressure|flow|rate|speed|rpm|hours?|runtime)\b/i.test(
      normalized,
    )
  ) {
    kinds.add('status');
  }

  return kinds;
}
