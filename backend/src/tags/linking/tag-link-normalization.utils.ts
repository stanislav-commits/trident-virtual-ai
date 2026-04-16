export function normalizeTagIds(tagIds: string[] | undefined): string[] {
  return [...new Set((tagIds ?? []).map((id) => id?.trim()).filter(Boolean))];
}

export function pickSingleTagIds(tagIds: string[]): string[] {
  const normalized = [...new Set(tagIds.map((id) => id?.trim()).filter(Boolean))];
  return normalized.length > 0 ? [normalized[0]] : [];
}

export function pickManualTagIds(
  tagIds: string[],
  maxMatches: number,
): string[] {
  return [...new Set(tagIds.map((id) => id?.trim()).filter(Boolean))].slice(
    0,
    maxMatches,
  );
}

export function truncateTagLinkLogValue(
  value: string,
  maxLength: number = 140,
): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function normalizeTagQueryText(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\bport[\s-]*side\b/g, ' port ')
    .replace(/\b(?:ps)\b/g, ' port ')
    .replace(/\bstarboard[\s-]*side\b/g, ' starboard ')
    .replace(/\b(?:stbd|stb|sb)\b/g, ' starboard ')
    .replace(/\bgensets?\b/g, ' generator ')
    .replace(/[_.:/\\-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
