export const normalizeTelemetryText = (value: string): string => {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_./:-]+/g, ' ')
    .replace(/[^a-zA-Z0-9\s]+/g, ' ')
    .replace(/\btemps?\b/g, ' temperature ')
    .replace(/\bvolt(s)?\b/g, ' voltage ')
    .replace(/\bstbd\b/g, ' starboard ')
    .replace(/\bsb\b/g, ' starboard ')
    .replace(/\bps\b/g, ' port ')
    .replace(/\bgenerator\s+set\b/g, ' genset ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
};

export const normalizeTelemetryToken = (token: string): string => {
  if (!token) return '';

  const normalized = token.toLowerCase();
  const aliases: Record<string, string> = {
    batteries: 'battery',
    generators: 'generator',
    gensets: 'genset',
    right: 'starboard',
    left: 'port',
    stbd: 'starboard',
    sb: 'starboard',
    ps: 'port',
    alarms: 'alarm',
    warnings: 'warning',
    faults: 'fault',
    trips: 'trip',
    status: 'status',
    statuses: 'status',
    states: 'state',
    volts: 'voltage',
    volt: 'voltage',
    voltages: 'voltage',
    pressures: 'pressure',
    currents: 'current',
    powers: 'power',
    energies: 'energy',
    loads: 'load',
    flows: 'flow',
    rates: 'rate',
    temps: 'temperature',
    temp: 'temperature',
    readings: 'reading',
    metrics: 'metric',
    values: 'value',
    ships: 'ship',
  };

  if (aliases[normalized]) {
    return aliases[normalized];
  }

  if (normalized.endsWith('ies') && normalized.length > 4) {
    return `${normalized.slice(0, -3)}y`;
  }

  if (
    normalized.endsWith('s') &&
    normalized.length > 4 &&
    !normalized.endsWith('ss')
  ) {
    return normalized.slice(0, -1);
  }

  return normalized;
};

export const expandTelemetryTokenVariants = (token: string): string[] => {
  const variants = new Set([token]);
  const aliasGroups = [
    ['generator', 'genset'],
    ['port', 'ps', 'left'],
    ['starboard', 'sb', 'stbd', 'right'],
    ['temperature', 'temp'],
    ['latitude', 'lat'],
    ['longitude', 'lon'],
    ['location', 'position', 'coordinates', 'coordinate', 'gps'],
  ];

  for (const group of aliasGroups) {
    if (group.includes(token)) {
      group.forEach((variant) => variants.add(variant));
    }
  }

  return [...variants];
};

export const canonicalizeTelemetrySubjectToken = (token: string): string => {
  switch (token) {
    case 'genset':
      return 'generator';
    case 'ps':
    case 'left':
      return 'port';
    case 'sb':
    case 'stbd':
    case 'right':
      return 'starboard';
    default:
      return token;
  }
};

export const matchesTelemetrySubjectToken = (
  haystack: string,
  token: string,
): boolean => {
  return expandTelemetryTokenVariants(token).some((variant) =>
    haystack.includes(variant),
  );
};
