/**
 * Lower-cased, trimmed form used for loose equality of free-text fields
 * (display name, brand, model) during import matching.
 */
export function lowerTrim(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

/**
 * Canonical key for matching spreadsheet column headers: lower-cased,
 * trimmed, whitespace collapsed, underscores treated as spaces.
 */
export function normalizeHeaderKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/_/g, ' ');
}
