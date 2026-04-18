import {
  normalizeTelemetryText,
  normalizeTelemetryToken,
} from '../telemetry-text.utils';
import {
  TELEMETRY_CLAUSE_FILLER_TOKENS,
  TELEMETRY_KIND_TOKENS,
  TELEMETRY_MEASUREMENT_ANCHOR_TOKENS,
  TELEMETRY_QUALIFIER_TOKENS,
  WEAK_SINGLE_TELEMETRY_CANDIDATES,
} from './telemetry-query-token.constants';

export function isTelemetryMeasurementAnchorToken(token: string): boolean {
  return TELEMETRY_MEASUREMENT_ANCHOR_TOKENS.has(
    normalizeTelemetryToken(token),
  );
}

export function isTelemetryCurrentQualifierToken(
  tokens: string[],
  index: number,
): boolean {
  if (tokens[index] !== 'current') {
    return false;
  }

  return tokens.some(
    (token, tokenIndex) =>
      tokenIndex > index &&
      isTelemetryMeasurementAnchorToken(token) &&
      token !== 'current',
  );
}

export function shouldIncludePreviousTokenInTelemetryMeasurementPhrase(
  previousToken: string,
  anchorToken: string,
): boolean {
  if (!previousToken || !anchorToken) {
    return false;
  }

  const normalizedPreviousToken = normalizeTelemetryToken(previousToken);
  const normalizedAnchorToken = normalizeTelemetryToken(anchorToken);

  if (normalizedAnchorToken === 'speed') {
    return new Set(['fan', 'wind']).has(normalizedPreviousToken);
  }

  if (normalizedAnchorToken === 'position') {
    return new Set(['throttle', 'rudder']).has(normalizedPreviousToken);
  }

  return false;
}

export function isTelemetryClauseFillerToken(token: string): boolean {
  return TELEMETRY_CLAUSE_FILLER_TOKENS.has(token);
}

export function isTelemetryQualifierPhrase(value: string): boolean {
  const tokens = normalizeTelemetryText(value)
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !isTelemetryClauseFillerToken(token));
  if (tokens.length === 0) {
    return false;
  }

  return tokens.every((token) => TELEMETRY_QUALIFIER_TOKENS.has(token));
}

export function isTelemetryKindToken(token: string): boolean {
  return TELEMETRY_KIND_TOKENS.has(token);
}

export function isStrongTelemetryCandidate(candidate: string): boolean {
  const normalized = normalizeTelemetryText(candidate);
  if (!normalized) return false;

  const terms = normalized.split(/\s+/).filter(Boolean);
  if (terms.length >= 2) return true;

  const [term] = terms;
  if (!term) return false;

  if (term.length >= 8) return true;
  if (term.length <= 3) return false;

  return !WEAK_SINGLE_TELEMETRY_CANDIDATES.has(term);
}
