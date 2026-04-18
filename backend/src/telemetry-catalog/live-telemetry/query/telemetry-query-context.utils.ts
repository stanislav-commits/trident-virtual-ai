export function hasStrictTelemetryContext(normalizedQuery: string): boolean {
  return /\b(engine room|generator|genset|engine|gearbox|pump|coolant|oil|fuel|battery)\b/i.test(
    normalizedQuery,
  );
}

export function isElectricalCurrentQuery(normalizedQuery: string): boolean {
  return (
    /\b(currents|amps?|amperage|rms current|phase current|current on phase|current phase|line current|ac current|dc current|current draw|charge current|charging current|discharge current|neutral current|starter current|alternator current)\b/i.test(
      normalizedQuery,
    ) ||
    /\b(battery|motor|generator|pump|inverter|charger|load)\s+current\b/i.test(
      normalizedQuery,
    ) ||
    /\b(battery|motor|generator|pump|inverter|charger|load|electrical|ac|dc)\b[\s\S]{0,80}\bcurrent\b/i.test(
      normalizedQuery,
    ) ||
    /\bvoltage\s+(?:and|or|with|\/)\s+current\b/i.test(normalizedQuery) ||
    /\bcurrent\s+(?:and|or|with|\/)\s+voltage\b/i.test(normalizedQuery)
  );
}
