import type { SemanticSourceCategory } from '../../contracts/semantic.types';
import { PROFILE_MATCH_STOP_WORDS } from './manual-semantic-stop-words.constants';
import {
  normalizeManualMatchText,
  tokenizeManualMatchText,
} from './manual-semantic-text.utils';

export function scoreManualArrayOverlap(
  left: string[],
  right: string[],
): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftValues = new Set(left.map((value) => normalizeManualMatchText(value)));
  return right
    .map((value) => normalizeManualMatchText(value))
    .filter((value) => leftValues.has(value)).length;
}

export function extractManualIdentifierAnchors(
  values: Array<string | null | undefined>,
): string[] {
  const anchors = new Set<string>();

  for (const value of values) {
    const tokens = tokenizeManualMatchText(value ?? '');
    for (let start = 0; start < tokens.length; start += 1) {
      const firstToken = tokens[start];
      if (
        !/\d/.test(firstToken) &&
        !(
          /^[a-z]{1,3}$/.test(firstToken) &&
          /\d/.test(tokens[start + 1] ?? '')
        )
      ) {
        continue;
      }

      let combined = '';
      let digitSeen = false;
      let alphaSeen = false;

      for (
        let length = 0;
        length < 3 && start + length < tokens.length;
        length += 1
      ) {
        const token = tokens[start + length];
        if (!token) {
          break;
        }

        if (
          !/\d/.test(token) &&
          !/^[a-z]{1,3}$/.test(token) &&
          combined.length > 0
        ) {
          break;
        }

        combined += token;
        digitSeen = digitSeen || /\d/.test(token);
        alphaSeen = alphaSeen || /[a-z]/.test(token);

        if (digitSeen && alphaSeen && combined.length >= 4) {
          anchors.add(combined);
        }

        if (
          length > 0 &&
          !/\d/.test(token) &&
          !/^[a-z]{1,3}$/.test(token)
        ) {
          break;
        }
      }
    }
  }

  return [...anchors];
}

export function scoreManualStructuredPhraseOverlap(
  profileValues: string[],
  queryValues: string[],
): number {
  if (profileValues.length === 0 || queryValues.length === 0) {
    return 0;
  }

  const profileTokenSets = profileValues
    .map((value) => tokenizeManualStructuredPhrase(value))
    .filter((tokens) => tokens.size > 0);
  if (profileTokenSets.length === 0) {
    return 0;
  }

  let score = 0;
  for (const queryValue of queryValues) {
    const queryTokens = tokenizeManualStructuredPhrase(queryValue);
    if (queryTokens.size === 0) {
      continue;
    }

    let bestMatch = 0;
    for (const profileTokens of profileTokenSets) {
      const sharedTokens = [...queryTokens].filter((token) =>
        profileTokens.has(token),
      );
      if (sharedTokens.length === 0) {
        continue;
      }

      if (
        sharedTokens.length === queryTokens.size &&
        sharedTokens.length === profileTokens.size
      ) {
        bestMatch = Math.max(bestMatch, 2);
        continue;
      }

      const overlapRatio = sharedTokens.length / queryTokens.size;
      if (overlapRatio >= 0.5) {
        bestMatch = Math.max(bestMatch, 1);
      }
    }

    score += bestMatch;
  }

  return score;
}

export function tokenizeManualStructuredPhrase(value: string): Set<string> {
  const structuredStopWords = new Set([
    ...PROFILE_MATCH_STOP_WORDS,
    'equipment',
    'set',
    'system',
    'systems',
    'unit',
    'units',
  ]);

  return new Set(
    tokenizeManualMatchText(value).filter(
      (token) => token.length > 2 && !structuredStopWords.has(token),
    ),
  );
}

export function scoreManualSourcePreference(
  category: string | null,
  sourcePreferences: SemanticSourceCategory[],
): number {
  if (!category) {
    return 0;
  }

  const index = sourcePreferences.indexOf(category as SemanticSourceCategory);
  if (index < 0) {
    return 0;
  }

  return Math.max(4, 14 - index * 3);
}
