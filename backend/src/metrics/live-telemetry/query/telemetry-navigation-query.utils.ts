export type NavigationSpeedKind = 'sog' | 'stw' | 'vmg';

export function isTelemetryLocationQuery(normalizedQuery: string): boolean {
  const hasExplicitLocationTerm =
    /\b(latitude|longitude|lat|lon|coordinates?|gps|location|whereabouts)\b/i.test(
      normalizedQuery,
    ) || /\bwhere\s+(?:are\s+we|am\s+i)\b/i.test(normalizedQuery);
  const hasVesselPositionTerm =
    /\bposition\b/i.test(normalizedQuery) &&
    !/\b(throttle|valve|switch|lever|damper|actuator|rudder|flap|fan|pump|engine|generator|genset|motor)\b/i.test(
      normalizedQuery,
    );
  const hasWhereIntent =
    /\bwhere\s+is\s+(?:the\s+)?(?:yacht|vessel|ship|boat)\b/i.test(
      normalizedQuery,
    ) || /\bwhere\s+(?:are\s+we|am\s+i)\b/i.test(normalizedQuery);

  return (
    (hasExplicitLocationTerm || hasVesselPositionTerm || hasWhereIntent) &&
    !/\b(spare|part|parts|supplier|manufacturer|quantity|reference)\b/i.test(
      normalizedQuery,
    )
  );
}

export function isNavigationLocationIntent(normalizedQuery: string): boolean {
  return (
    isTelemetryLocationQuery(normalizedQuery) ||
    /\bwhere\s+(?:are\s+we|am\s+i)\b/i.test(normalizedQuery) ||
    /\bwhereabouts\b/i.test(normalizedQuery) ||
    /\bwhere\s+is\s+(?:the\s+)?(?:yacht|vessel|ship|boat)\b/i.test(
      normalizedQuery,
    )
  );
}

export function isNavigationSpeedIntent(normalizedQuery: string): boolean {
  return (
    /\b(speed|pace|sog|stw|vmg|knots?|kts?)\b/i.test(normalizedQuery) ||
    /\bhow\s+fast\b/i.test(normalizedQuery) ||
    /\b(?:are\s+we|we\s+are|vessel\s+is|yacht\s+is|ship\s+is|boat\s+is)\s+(?:moving|sailing|underway)\b/i.test(
      normalizedQuery,
    )
  );
}

export function isNavigationHeadingIntent(normalizedQuery: string): boolean {
  return (
    /\b(heading|heading\s+true|heading\s+magnetic)\b/i.test(
      normalizedQuery,
    ) || /\b(course\s+over\s+ground|cog)\b/i.test(normalizedQuery)
  );
}

export function hasVesselNavigationContext(normalizedQuery: string): boolean {
  return /\b(yacht|vessel|ship|boat|navigation|nav|gps|position|location|coordinates?|latitude|longitude|lat|lon|heading|course|cog|sog|stw|vmg)\b/i.test(
    normalizedQuery,
  );
}

export function hasNonNavigationPrimarySpeedSubject(
  normalizedQuery: string,
): boolean {
  return (
    /\b(wind|fan|blower|hvac|pump|compressor|engine|genset|generator|motor|throttle|shaft|propeller|rudder)\s+(?:speed|rpm|position)\b/i.test(
      normalizedQuery,
    ) ||
    /\b(?:speed|rpm|position)\s+(?:of|for|in|on)\s+(?:the\s+)?(?:wind|fan|blower|hvac|pump|compressor|engine|genset|generator|motor|throttle|shaft|propeller|rudder)\b/i.test(
      normalizedQuery,
    )
  );
}

export function getPreferredNavigationSpeedKind(
  normalizedQuery: string,
): NavigationSpeedKind | undefined {
  if (/\b(?:speed\s+over\s+ground|sog)\b/i.test(normalizedQuery)) {
    return 'sog';
  }
  if (
    /\b(?:speed\s+through\s+water|stw|water\s+speed)\b/i.test(normalizedQuery)
  ) {
    return 'stw';
  }
  if (/\b(?:velocity\s+made\s+good|vmg)\b/i.test(normalizedQuery)) {
    return 'vmg';
  }
  return undefined;
}

export function getNavigationSpeedIntentIndex(
  normalizedQuery: string,
): number {
  const match = normalizedQuery.match(
    /\b(speed|pace|sog|stw|vmg|how\s+fast|moving|sailing|underway)\b/i,
  );
  return match?.index ?? -1;
}

export function getNavigationLocationIntentIndex(
  normalizedQuery: string,
): number {
  const match = normalizedQuery.match(
    /\b(latitude|longitude|lat|lon|coordinates?|position|gps|location|whereabouts|where\s+(?:is|are))\b/i,
  );
  return match?.index ?? -1;
}

export function getNavigationHeadingIntentIndex(
  normalizedQuery: string,
): number {
  const match = normalizedQuery.match(
    /\b(heading|heading\s+true|heading\s+magnetic|course\s+over\s+ground|cog)\b/i,
  );
  return match?.index ?? -1;
}

export function getNavigationWindIntentIndex(normalizedQuery: string): number {
  const match = normalizedQuery.match(/\bwind\b/i);
  return match?.index ?? -1;
}

export function hasTelemetryNavigationPositionContext(
  normalizedValue: string,
): boolean {
  return /\b(navigation|nav|nmea|gps|coordinate|coordinates|latitude|longitude|lat|lon|location|yacht|vessel|ship|boat|course|waypoint|route)\b/i.test(
    normalizedValue,
  );
}
