export function normalizeTrimmedText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function normalizeImoNumber(value: unknown): string | null {
  const normalized =
    typeof value === 'number' && Number.isInteger(value)
      ? String(value)
      : normalizeTrimmedText(value);

  if (!normalized) {
    return null;
  }

  return normalized.replace(/^IMO\s*/i, '').replace(/\s+/g, '');
}

export function normalizeOptionalInteger(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }

  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }

  return value as number | undefined;
}
