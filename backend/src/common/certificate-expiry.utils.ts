const CERTIFICATE_EXPIRY_DATE_PATTERN_SOURCE =
  String.raw`\b(?:valid\s+until|expiry(?:\s+date)?|expiration(?:\s+date)?|expiring|expires?\s+on|expire\s+on|will\s+expire\s+on|scadenza(?:\s*\/\s*expiring)?|expiring:)\b[^0-9a-z]{0,20}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?(?:\s+|[-/])[a-z]{3,9}(?:\s+|[-/])\d{2,4})\b`;

const CERTIFICATE_MONTH_NAMES = new Map<string, number>([
  ['jan', 0],
  ['january', 0],
  ['feb', 1],
  ['february', 1],
  ['mar', 2],
  ['march', 2],
  ['apr', 3],
  ['april', 3],
  ['may', 4],
  ['jun', 5],
  ['june', 5],
  ['jul', 6],
  ['july', 6],
  ['aug', 7],
  ['august', 7],
  ['sep', 8],
  ['sept', 8],
  ['september', 8],
  ['oct', 9],
  ['october', 9],
  ['nov', 10],
  ['november', 10],
  ['dec', 11],
  ['december', 11],
]);

export interface CertificateExpiryEntry {
  timestamp: number;
  displayDate: string;
}

export function isBroadCertificateSoonQuery(query: string): boolean {
  return (
    /\b(certificates?|certifications?)\b/i.test(query) &&
    /\b(expire|expiry|expiries|expiring|valid\s+until|due\s+to\s+expire)\b/i.test(
      query,
    ) &&
    /\b(soon|upcoming|next|nearest)\b/i.test(query)
  );
}

export function stripHtmlLikeMarkup(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractCertificateExpiryTimestamps(text?: string): number[] {
  const plainText = stripHtmlLikeMarkup(text ?? '');
  if (!plainText) {
    return [];
  }

  const pattern = new RegExp(CERTIFICATE_EXPIRY_DATE_PATTERN_SOURCE, 'gi');
  const timestamps = new Set<number>();

  for (const match of plainText.matchAll(pattern)) {
    if (!match[1]) {
      continue;
    }

    const timestamp = parseCertificateDateToken(match[1]);
    if (timestamp !== null) {
      timestamps.add(timestamp);
    }
  }

  return [...timestamps].sort((left, right) => left - right);
}

export function extractFirstCertificateExpiryTimestamp(
  text?: string,
): number | null {
  const plainText = stripHtmlLikeMarkup(text ?? '');
  if (!plainText) {
    return null;
  }

  const pattern = new RegExp(CERTIFICATE_EXPIRY_DATE_PATTERN_SOURCE, 'i');
  const match = plainText.match(pattern);
  if (!match?.[1]) {
    return null;
  }

  return parseCertificateDateToken(match[1]);
}

export function extractCertificateExpiryEntries(
  text?: string,
): CertificateExpiryEntry[] {
  return extractCertificateExpiryTimestamps(text).map((timestamp) => ({
    timestamp,
    displayDate: formatCertificateExpiryDate(timestamp),
  }));
}

export function parseCertificateDateToken(token: string): number | null {
  const normalized = token.replace(/\s+/g, ' ').trim();

  const numericMatch = normalized.match(
    /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/,
  );
  if (numericMatch) {
    const day = Number.parseInt(numericMatch[1], 10);
    const month = Number.parseInt(numericMatch[2], 10) - 1;
    let year = Number.parseInt(numericMatch[3], 10);
    if (year < 100) {
      year += year >= 70 ? 1900 : 2000;
    }
    const timestamp = Date.UTC(year, month, day);
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  const monthNameMatch = normalized.match(
    /^(\d{1,2})(?:st|nd|rd|th)?(?:\s+|[-/])([a-z]{3,9})(?:\s+|[-/])(\d{2,4})$/i,
  );
  if (monthNameMatch) {
    const day = Number.parseInt(monthNameMatch[1], 10);
    const month = CERTIFICATE_MONTH_NAMES.get(monthNameMatch[2].toLowerCase());
    if (month === undefined) {
      return null;
    }
    let year = Number.parseInt(monthNameMatch[3], 10);
    if (year < 100) {
      year += year >= 70 ? 1900 : 2000;
    }
    const timestamp = Date.UTC(year, month, day);
    return Number.isNaN(timestamp) ? null : timestamp;
  }

  return null;
}

export function formatCertificateExpiryDate(timestamp: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}
