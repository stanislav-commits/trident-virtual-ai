import type { MatchableTag } from '../tag-matcher.service';
import { normalizeTagQueryText } from './tag-link-normalization.utils';

export interface QueryTagMatch {
  tagId: string;
  key: string;
  score: number;
}

type StoredFluidQuerySubject = 'fuel' | 'oil' | 'water' | 'coolant' | 'def';

export function inferStoredFluidInventoryTagMatches(
  query: string,
  profiles: Array<{ tag: MatchableTag }>,
): QueryTagMatch[] {
  const normalizedQuery = normalizeTagQueryText(query);
  const fluid = detectStoredFluidQuerySubject(normalizedQuery);
  if (!fluid || !isStoredFluidInventoryQuery(normalizedQuery, fluid)) {
    return [];
  }

  return profiles
    .filter(
      (profile) =>
        profile.tag.item === 'storage_tank' &&
        tagMatchesStoredFluid(profile.tag, fluid),
    )
    .slice(0, 4)
    .map((profile) => ({
      tagId: profile.tag.id,
      key: profile.tag.key,
      score: 10,
    }));
}

export function detectStoredFluidQuerySubject(
  normalizedQuery: string,
): StoredFluidQuerySubject | null {
  if (/\bfuel\b/i.test(normalizedQuery)) return 'fuel';
  if (/\boil\b/i.test(normalizedQuery)) return 'oil';
  if (/\bcoolant\b/i.test(normalizedQuery)) return 'coolant';
  if (/\b(def|urea)\b/i.test(normalizedQuery)) return 'def';
  if (/\b(water|fresh water|seawater)\b/i.test(normalizedQuery)) {
    return 'water';
  }
  return null;
}

export function isStoredFluidInventoryQuery(
  normalizedQuery: string,
  fluid: StoredFluidQuerySubject,
): boolean {
  const fluidPattern =
    fluid === 'water'
      ? /\b(water|fresh water|seawater)\b/i
      : fluid === 'def'
        ? /\b(def|urea)\b/i
        : new RegExp(`\\b${fluid}\\b`, 'i');

  if (!fluidPattern.test(normalizedQuery)) {
    return false;
  }

  if (
    /\b(used|consumed|consumption|usage|burn(?:ed|t|ing)?|spent|rate|flow|pressure|temp(?:erature)?|voltage|power|energy|frequency|pump|transfer)\b/i.test(
      normalizedQuery,
    )
  ) {
    return false;
  }

  const hasTankContext = /\b(tank|tanks|storage)\b/i.test(normalizedQuery);
  const hasInventoryIntent =
    /\b(level|levels|quantity|volume|contents?|inventory|remaining|left|available|onboard|amount)\b/i.test(
      normalizedQuery,
    );
  const isLookupStyleQuestion =
    /\b(what|show|list|display|give|tell|provide)\b/i.test(normalizedQuery);

  return hasInventoryIntent || (hasTankContext && isLookupStyleQuestion);
}

export function tagMatchesStoredFluid(
  tag: MatchableTag,
  fluid: StoredFluidQuerySubject,
): boolean {
  const normalizedKey = normalizeTagQueryText(tag.key.replace(/:/g, ' '));
  const normalizedSubcategory = normalizeTagQueryText(tag.subcategory);

  switch (fluid) {
    case 'water':
      return (
        /\bwater\b/i.test(normalizedKey) ||
        /\bwater\b/i.test(normalizedSubcategory)
      );
    case 'def':
      return (
        /\b(def|urea|adblue)\b/i.test(normalizedKey) ||
        /\b(def|urea)\b/i.test(normalizedSubcategory)
      );
    default:
      return (
        new RegExp(`\\b${fluid}\\b`, 'i').test(normalizedKey) ||
        new RegExp(`\\b${fluid}\\b`, 'i').test(normalizedSubcategory)
      );
  }
}
