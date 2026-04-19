export function normalizeMetricDescription(
  value?: string | null,
): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export interface ParsedMetricCatalogKey {
  bucket: string | null;
  measurement: string | null;
  field: string | null;
}

export function parseMetricCatalogKey(key: string): ParsedMetricCatalogKey {
  const [bucketPart, measurementPart, ...fieldParts] = key
    .split('::')
    .map((segment) => segment.trim());

  return {
    bucket: bucketPart || null,
    measurement: measurementPart || null,
    field: fieldParts.join('::').trim() || null,
  };
}

export function isLegacyGeneratedMetricDescription(
  value?: string | null,
): boolean {
  const normalized = normalizeMetricDescription(value);

  if (!normalized) {
    return false;
  }

  return /^Displays the current\b/i.test(normalized);
}

export function shouldBackfillMetricDescription(
  value?: string | null,
): boolean {
  const normalized = normalizeMetricDescription(value);
  return !normalized || isLegacyGeneratedMetricDescription(normalized);
}
