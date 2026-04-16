import type { ManualSemanticProfile } from '../semantic.types';
import { PROFILE_MATCH_STOP_WORDS } from './manual-semantic-stop-words.constants';

export function buildManualProfileAnchorText(
  profile: ManualSemanticProfile,
): string {
  return [
    profile.vendor,
    profile.model,
    ...profile.aliases,
    ...profile.equipment,
    ...profile.systems,
    profile.summary,
    ...profile.sections.flatMap((section) => [
      section.title,
      section.summary,
    ]),
    ...profile.pageTopics.map((topic) => topic.summary),
  ]
    .filter((value): value is string => Boolean(value))
    .join(' ');
}

export function normalizeManualCategory(value?: string | null): string | null {
  const normalized = value?.trim().toUpperCase();
  return normalized || null;
}

export function normalizeManualMatchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_:./\\-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenizeManualMatchText(value: string): string[] {
  return mergeManualAcronymLetterTokens(normalizeManualMatchText(value).split(' '))
    .split(' ')
    .map((token) => normalizeManualMatchToken(token))
    .filter(
      (token) => token.length > 1 && !PROFILE_MATCH_STOP_WORDS.has(token),
    );
}

export function mergeManualAcronymLetterTokens(tokens: string[]): string {
  const merged: string[] = [];
  let acronymBuffer = '';

  const flushAcronymBuffer = () => {
    if (!acronymBuffer) {
      return;
    }
    merged.push(acronymBuffer);
    acronymBuffer = '';
  };

  for (const token of tokens) {
    if (/^[a-z]$/.test(token)) {
      acronymBuffer += token;
      if (acronymBuffer.length >= 3) {
        flushAcronymBuffer();
      }
      continue;
    }

    flushAcronymBuffer();
    merged.push(token);
  }

  flushAcronymBuffer();
  return merged.join(' ');
}

export function normalizeManualMatchToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1);
  }
  return token;
}

export function collapseManualMatchText(value: string): string {
  return normalizeManualMatchText(value).replace(/\s+/g, '');
}

export function containsWholeNormalizedPhrase(
  normalizedText: string,
  normalizedPhrase: string,
): boolean {
  if (!normalizedText || !normalizedPhrase) {
    return false;
  }

  return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

export function truncateManualSemanticLogValue(
  value: string,
  maxLength = 140,
): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`;
}
