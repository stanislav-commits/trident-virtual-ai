import { TELEMETRY_QUERY_STOP_WORDS } from './telemetry-query-stop-words.constants';
import {
  expandTelemetryTokenVariants,
  normalizeTelemetryText,
  normalizeTelemetryToken,
} from '../telemetry-text.utils';

export interface TelemetryQuerySignals {
  normalizedQuery: string;
  tokens: string[];
  phrases: string[];
}

export function buildTelemetryQuerySignals(
  query: string,
  resolvedSubjectQuery?: string,
): TelemetryQuerySignals {
  const rawSearchSpace = `${query}\n${resolvedSubjectQuery ?? ''}`;
  const normalizedQuery = normalizeTelemetryText(rawSearchSpace);
  const explicitDirectionalTokens =
    extractExplicitTelemetryDirectionalTokens(rawSearchSpace);

  const baseTokens = [
    ...new Set(
      normalizedQuery
        .split(/\s+/)
        .map((token) => normalizeTelemetryToken(token.trim()))
        .filter(Boolean)
        .filter((token) => token.length >= 2)
        .filter((token) => !/^\d+$/.test(token))
        .filter((token) => !TELEMETRY_QUERY_STOP_WORDS.has(token))
        .filter(
          (token) =>
            !isTelemetryDirectionalToken(token) ||
            explicitDirectionalTokens.has(token),
        ),
    ),
  ];

  const tokens = [
    ...new Set(
      baseTokens.flatMap((token) => expandTelemetryTokenVariants(token)),
    ),
  ];

  const phrases = [
    ...new Set(
      baseTokens.flatMap((_, index) => {
        const phrases: string[] = [];
        const pair = baseTokens.slice(index, index + 2);
        const triple = baseTokens.slice(index, index + 3);
        if (pair.length === 2) phrases.push(pair.join(' '));
        if (triple.length === 3) phrases.push(triple.join(' '));
        return phrases;
      }),
    ),
  ];

  return {
    normalizedQuery,
    tokens,
    phrases,
  };
}

export function isTelemetryDirectionalToken(token: string): boolean {
  return token === 'port' || token === 'starboard';
}

export function extractExplicitTelemetryDirectionalTokens(
  query: string,
): Set<string> {
  const normalized = query.toLowerCase();
  const tokens = new Set<string>();
  const directionalNouns =
    '(side|engine|generator|genset|pump|tank|battery|charger|motor|gearbox|thruster|rudder|cabin|room|propeller)';

  if (/\b(port|ps)\b/i.test(normalized)) {
    tokens.add('port');
  }

  if (/\b(starboard|stbd|sb)\b/i.test(normalized)) {
    tokens.add('starboard');
  }

  if (
    new RegExp(`\\bleft\\b\\s+${directionalNouns}\\b`, 'i').test(normalized)
  ) {
    tokens.add('port');
  }

  if (
    new RegExp(`\\bright\\b\\s+${directionalNouns}\\b`, 'i').test(normalized)
  ) {
    tokens.add('starboard');
  }

  return tokens;
}
