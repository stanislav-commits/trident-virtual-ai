const TRAILING_NOISE_TOKENS = new Set([
  'value',
  'values',
  'reading',
  'readings',
  'metric',
  'metrics',
  'telemetry',
  'signal',
  'signals',
  'sensor',
  'sensors',
  'data',
]);

const TRAILING_UNIT_TOKENS = new Set([
  'l',
  'liter',
  'liters',
  'litre',
  'litres',
  'gallon',
  'gallons',
  'percent',
  'percentage',
  'degree',
  'degrees',
  'deg',
  'celsius',
  'fahrenheit',
  'volt',
  'volts',
  'amp',
  'amps',
  'ampere',
  'amperes',
  'bar',
  'psi',
  'kn',
  'knot',
  'knots',
  'nm',
  'kw',
  'kwh',
  'hz',
]);

const UPPERCASE_TOKEN_MAP = new Map<string, string>([
  ['rpm', 'RPM'],
  ['vmg', 'VMG'],
  ['gps', 'GPS'],
  ['nmea', 'NMEA'],
  ['stw', 'STW'],
  ['sog', 'SOG'],
  ['plc', 'PLC'],
  ['uv', 'UV'],
  ['ac', 'AC'],
  ['dc', 'DC'],
  ['sb', 'SB'],
  ['ps', 'PS'],
  ['stbd', 'STBD'],
  ['stb', 'STBD'],
  ['fwd', 'FWD'],
  ['aft', 'AFT'],
]);

export function humanizeMetricDisplayName(value: string): string {
  const normalized = normalizeMetricDisplaySource(value);
  if (!normalized) {
    return '';
  }

  const tokens = stripTrailingDisplayNoise(normalized.split(' '));
  const effectiveTokens = tokens.length > 0 ? tokens : normalized.split(' ');

  return effectiveTokens.map((token) => humanizeMetricDisplayToken(token)).join(' ');
}

function normalizeMetricDisplaySource(value: string): string {
  return value
    .split('::')
    .slice(-1)[0]
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[_./:-]+/g, ' ')
    .replace(/(\d+)\s+([a-z]{1,2}\b)/gi, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTrailingDisplayNoise(tokens: string[]): string[] {
  const cleaned = [...tokens];

  while (cleaned.length > 1) {
    const tail = cleaned[cleaned.length - 1]?.toLowerCase();
    if (
      TRAILING_NOISE_TOKENS.has(tail) ||
      TRAILING_UNIT_TOKENS.has(tail)
    ) {
      cleaned.pop();
      continue;
    }

    break;
  }

  return cleaned;
}

function humanizeMetricDisplayToken(token: string): string {
  if (!token) {
    return '';
  }

  const lower = token.toLowerCase();
  if (lower === 'lat' || lower === 'latitude') {
    return 'Latitude';
  }
  if (lower === 'lon' || lower === 'longitude') {
    return 'Longitude';
  }

  const mappedUppercase = UPPERCASE_TOKEN_MAP.get(lower);
  if (mappedUppercase) {
    return mappedUppercase;
  }

  if (/^\d+$/.test(token)) {
    return token;
  }

  if (/^\d+[a-z]{1,2}$/i.test(token)) {
    return token.replace(/^(\d+)([a-z]{1,2})$/i, (_, digits, suffix) => {
      return `${digits}${suffix.toUpperCase()}`;
    });
  }

  if (/^[a-z]{1,2}\d+[a-z]?$/i.test(token)) {
    return token.toUpperCase();
  }

  if (/^[A-Z]{2,}$/.test(token)) {
    return token.charAt(0) + token.slice(1).toLowerCase();
  }

  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
