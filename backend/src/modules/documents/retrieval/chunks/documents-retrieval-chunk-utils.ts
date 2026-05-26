export function extractChunkPages(positions: unknown[] | undefined): number[] {
  const pages: number[] = [];

  for (const position of positions ?? []) {
    const page = extractPositionPage(position);

    if (typeof page === 'number' && Number.isFinite(page) && page > 0) {
      pages.push(page);
    }
  }

  return Array.from(new Set(pages)).sort((left, right) => left - right);
}

export function extractFirstChunkPage(
  positions: unknown[] | undefined,
): number | null {
  return extractChunkPages(positions)[0] ?? null;
}

function extractPositionPage(position: unknown): number | null {
  if (Array.isArray(position)) {
    return typeof position[0] === 'number' ? position[0] : null;
  }

  if (position && typeof position === 'object') {
    if (
      'page' in position &&
      typeof (position as { page?: unknown }).page === 'number'
    ) {
      return (position as { page: number }).page;
    }

    if (
      'page_num' in position &&
      typeof (position as { page_num?: unknown }).page_num === 'number'
    ) {
      return (position as { page_num: number }).page_num;
    }
  }

  return null;
}
