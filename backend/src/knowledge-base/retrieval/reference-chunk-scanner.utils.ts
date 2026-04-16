/**
 * Pure helpers for reference-ID-anchored chunk scanning, boundary
 * expansion, and chunk position extraction from RAGFlow metadata.
 *
 * Every exported function is deterministic and stateless.
 */

// ---------------------------------------------------------------------------
// Types (minimal - mirrored from scan service to stay decoupled)
// ---------------------------------------------------------------------------

export interface EnrichedChunkLike {
  chunk: {
    id: string;
    content: string;
    similarity?: number;
    meta?: Record<string, unknown>;
    positions?: unknown;
  };
  rawContent: string;
  content: string;
  haystack: string;
  pageNumber?: number;
  minY?: number;
}

// ---------------------------------------------------------------------------
// Chunk position extraction (used by both interval & reference scanners)
// ---------------------------------------------------------------------------

export function extractChunkPageNumber(
  chunk: { meta?: Record<string, unknown>; positions?: unknown },
): number | undefined {
  const metaPage = chunk.meta?.page_num;
  if (typeof metaPage === 'number' && Number.isFinite(metaPage)) {
    return metaPage;
  }

  const pages = collectChunkPositionValues(chunk.positions)
    .map((value) => value[0])
    .filter((value): value is number => Number.isFinite(value));
  if (pages.length === 0) return undefined;

  const counts = new Map<number, number>();
  for (const page of pages) {
    counts.set(page, (counts.get(page) ?? 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => {
    if (a[1] !== b[1]) return b[1] - a[1];
    return a[0] - b[0];
  })[0]?.[0];
}

export function extractChunkMinY(positions: unknown): number | undefined {
  const yValues = collectChunkPositionValues(positions)
    .map((value) => value[3])
    .filter((value): value is number => Number.isFinite(value));
  if (yValues.length === 0) return undefined;
  return Math.min(...yValues);
}

export function collectChunkPositionValues(positions: unknown): number[][] {
  if (positions === null || positions === undefined) return [];

  if (Array.isArray(positions)) {
    if (
      positions.length >= 5 &&
      positions.every((value) => typeof value === 'number')
    ) {
      return [positions as number[]];
    }

    return positions.flatMap((entry) => collectChunkPositionValues(entry));
  }

  if (typeof positions === 'object') {
    const value = (positions as Record<string, unknown>).value;
    if (value !== undefined) {
      return collectChunkPositionValues(value);
    }
  }

  return [];
}

export function extractChunkMetadataValue(
  chunk: { meta?: Record<string, unknown> },
  key: string,
): string | undefined {
  const value = chunk.meta?.[key];
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

// ---------------------------------------------------------------------------
// Reference-anchored chunk scoring
// ---------------------------------------------------------------------------

export function scoreReferenceAnchorChunk(
  referenceId: string,
  entry: Pick<EnrichedChunkLike, 'content' | 'rawContent' | 'haystack' | 'minY'>,
): number {
  let score = 0;
  const foreignRefsBeforeTarget = countForeignReferencesBeforeTarget(
    referenceId,
    entry.rawContent,
  );
  const foreignRefsAfterTarget = countForeignReferencesAfterTarget(
    referenceId,
    entry.rawContent,
  );

  if (entry.haystack.includes(referenceId)) {
    score += 40;
  }

  if (
    /\b(reference\s*id|responsible|interval|last\s*due|next\s*due)\b/i.test(
      entry.content,
    )
  ) {
    score += 20;
  }

  if (
    /\b(responsible|interval|last\s*due|next\s*due|years?|hours?|chief\s*engineer|costs?)\b/i.test(
      entry.content,
    )
  ) {
    score += 12;
  }

  if (/\b(component\s*name|task\s*name)\b/i.test(entry.content)) {
    score += 8;
  }

  if (
    /\b(spare\s*name|manufacturer\s*part#?|supplier\s*part#?)\b/i.test(
      entry.content,
    )
  ) {
    score -= 4;
  }

  score -= foreignRefsBeforeTarget * 12;
  score -= foreignRefsAfterTarget * 2;

  if (entry.minY !== undefined) {
    score += Math.max(0, 4 - entry.minY / 80);
  }

  score -= Math.floor(entry.content.length / 450);

  return score;
}

// ---------------------------------------------------------------------------
// Reference snippet trimming
// ---------------------------------------------------------------------------

export function trimSnippetBeforeForeignReference(
  snippet: string,
  referenceId: string,
): string {
  if (!snippet) return snippet;

  const normalizedReference = referenceId.toLowerCase();
  const anchorIndex = snippet.toLowerCase().indexOf(normalizedReference);
  const firstForeignMatch = [...snippet.matchAll(/\b1p\d{2,}\b/gi)].find(
    (match) => {
      if (match[0].toLowerCase() === normalizedReference) {
        return false;
      }
      if (typeof match.index !== 'number') {
        return false;
      }
      return anchorIndex < 0 || match.index > anchorIndex;
    },
  );
  if (
    !firstForeignMatch ||
    typeof firstForeignMatch.index !== 'number' ||
    firstForeignMatch.index <= 0
  ) {
    return snippet;
  }

  if (anchorIndex >= 0) {
    const startIndex = findReferenceSnippetStartIndex(snippet, anchorIndex);
    return snippet.slice(startIndex, firstForeignMatch.index).trim();
  }

  return snippet.slice(0, firstForeignMatch.index).trim();
}

function findReferenceSnippetStartIndex(
  snippet: string,
  anchorIndex: number,
): number {
  const blockStartPatterns = [/<table\b/gi, /<tr\b/gi];

  for (const pattern of blockStartPatterns) {
    let lastMatchIndex = -1;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(snippet)) !== null) {
      if (typeof match.index === 'number' && match.index < anchorIndex) {
        lastMatchIndex = match.index;
        continue;
      }
      break;
    }

    if (lastMatchIndex >= 0) {
      return lastMatchIndex;
    }
  }

  const previousLineBreak = Math.max(
    snippet.lastIndexOf('\n', anchorIndex),
    snippet.lastIndexOf('\r', anchorIndex),
  );
  if (previousLineBreak >= 0) {
    return previousLineBreak + 1;
  }

  return anchorIndex;
}

// ---------------------------------------------------------------------------
// Reference chunk selection & boundary expansion
// ---------------------------------------------------------------------------

export function selectReferenceRelevantChunks(
  referenceId: string,
  sortedPageChunks: EnrichedChunkLike[],
  bestAnchorChunk: EnrichedChunkLike,
  relevancePattern: RegExp,
): EnrichedChunkLike[] {
  const matchesReference = (
    entry: Pick<EnrichedChunkLike, 'haystack' | 'content'>,
  ) => {
    if (entry.haystack.includes(referenceId)) {
      return true;
    }

    const mentionedReferenceIds = [
      ...entry.haystack.matchAll(/\b1p\d{2,}\b/g),
    ].map((match) => match[0].toLowerCase());
    if (
      mentionedReferenceIds.some(
        (mentionedReferenceId) => mentionedReferenceId !== referenceId,
      )
    ) {
      return false;
    }

    return relevancePattern.test(entry.haystack);
  };

  const fallbackSelection = sortedPageChunks.filter(
    (entry) => entry.content.trim() && matchesReference(entry),
  );

  const chunkBands = buildReferenceChunkBands(sortedPageChunks);
  const anchorBandIndex = chunkBands.findIndex((band) =>
    band.entries.some((entry) => entry.chunk.id === bestAnchorChunk.chunk.id),
  );
  if (anchorBandIndex < 0) {
    return fallbackSelection;
  }

  const selected = chunkBands
    .slice(anchorBandIndex, anchorBandIndex + 2)
    .flatMap((band) => band.entries)
    .filter((entry) => {
      if (!entry.content.trim()) return false;

      if (
        bestAnchorChunk.minY !== undefined &&
        entry.minY !== undefined &&
        entry.minY + 8 < bestAnchorChunk.minY
      ) {
        return false;
      }

      return matchesReference(entry);
    });

  const baseSelection = selected.length > 0 ? selected : fallbackSelection;
  return expandReferenceBoundaryChunks(
    referenceId,
    sortedPageChunks,
    baseSelection,
    relevancePattern,
  );
}

function expandReferenceBoundaryChunks(
  referenceId: string,
  sortedPageChunks: EnrichedChunkLike[],
  selectedChunks: EnrichedChunkLike[],
  relevancePattern: RegExp,
): EnrichedChunkLike[] {
  if (selectedChunks.length === 0) {
    return selectedChunks;
  }

  const selectedIds = new Set(selectedChunks.map((entry) => entry.chunk.id));
  const selectedIndexes = sortedPageChunks
    .map((entry, index) => (selectedIds.has(entry.chunk.id) ? index : -1))
    .filter((index) => index >= 0);
  if (selectedIndexes.length === 0) {
    return selectedChunks;
  }

  const expanded = [...selectedChunks];
  const firstIndex = Math.min(...selectedIndexes);
  const lastIndex = Math.max(...selectedIndexes);

  for (const direction of [-1, 1] as const) {
    let currentIndex = direction < 0 ? firstIndex - 1 : lastIndex + 1;
    for (let step = 0; step < 2; step += 1) {
      if (currentIndex < 0 || currentIndex >= sortedPageChunks.length) {
        break;
      }

      const candidate = sortedPageChunks[currentIndex];
      if (
        !shouldIncludeReferenceBoundaryChunk(
          referenceId,
          candidate,
          expanded,
          relevancePattern,
        )
      ) {
        break;
      }

      if (!selectedIds.has(candidate.chunk.id)) {
        selectedIds.add(candidate.chunk.id);
        expanded.push(candidate);
      }

      currentIndex += direction;
    }
  }

  return expanded.sort((a, b) => {
    if (a.pageNumber !== undefined && b.pageNumber !== undefined) {
      if (a.pageNumber !== b.pageNumber) {
        return a.pageNumber - b.pageNumber;
      }
    }

    if (a.minY !== undefined && b.minY !== undefined && a.minY !== b.minY) {
      return a.minY - b.minY;
    }

    return (b.chunk.similarity ?? 0) - (a.chunk.similarity ?? 0);
  });
}

function shouldIncludeReferenceBoundaryChunk(
  referenceId: string,
  candidate: EnrichedChunkLike,
  selectedChunks: EnrichedChunkLike[],
  relevancePattern: RegExp,
): boolean {
  if (!candidate.content.trim()) {
    return false;
  }

  const selectedPages = new Set(
    selectedChunks
      .map((entry) => entry.pageNumber)
      .filter((page): page is number => page !== undefined),
  );
  if (
    candidate.pageNumber !== undefined &&
    selectedPages.size > 0 &&
    !selectedPages.has(candidate.pageNumber)
  ) {
    return false;
  }

  const mentionedReferenceIds = [
    ...candidate.haystack.matchAll(/\b1p\d{2,}\b/g),
  ].map((match) => match[0].toLowerCase());
  if (
    mentionedReferenceIds.some(
      (mentionedReferenceId) => mentionedReferenceId !== referenceId,
    )
  ) {
    return false;
  }

  const nearestDistance = selectedChunks.reduce((best, entry) => {
    if (
      candidate.pageNumber !== undefined &&
      entry.pageNumber !== undefined &&
      candidate.pageNumber !== entry.pageNumber
    ) {
      return best;
    }

    if (candidate.minY === undefined || entry.minY === undefined) {
      return Math.min(best, 0);
    }

    return Math.min(best, Math.abs(candidate.minY - entry.minY));
  }, Number.POSITIVE_INFINITY);

  if (nearestDistance > 110) {
    return false;
  }

  if (candidate.haystack.includes(referenceId)) {
    return true;
  }

  return relevancePattern.test(candidate.haystack);
}

function buildReferenceChunkBands(
  sortedPageChunks: EnrichedChunkLike[],
): Array<{ startY?: number; entries: EnrichedChunkLike[] }> {
  const bands: Array<{ startY?: number; entries: EnrichedChunkLike[] }> = [];

  for (const entry of sortedPageChunks) {
    const lastBand = bands.at(-1);
    if (
      !lastBand ||
      lastBand.startY === undefined ||
      entry.minY === undefined ||
      entry.minY - lastBand.startY > 28
    ) {
      bands.push({
        startY: entry.minY,
        entries: [entry],
      });
      continue;
    }

    lastBand.entries.push(entry);
  }

  return bands;
}

// ---------------------------------------------------------------------------
// Foreign reference counting
// ---------------------------------------------------------------------------

export function countForeignReferencesBeforeTarget(
  referenceId: string,
  snippet: string,
): number {
  const normalizedReference = referenceId.toLowerCase();
  const normalizedSnippet = snippet.toLowerCase();
  const anchorIndex = normalizedSnippet.indexOf(normalizedReference);
  if (anchorIndex < 0) {
    return 0;
  }

  return [...normalizedSnippet.matchAll(/\b1p\d{2,}\b/g)].filter((match) => {
    if (match[0] === normalizedReference) {
      return false;
    }
    return typeof match.index === 'number' && match.index < anchorIndex;
  }).length;
}

export function countForeignReferencesAfterTarget(
  referenceId: string,
  snippet: string,
): number {
  const normalizedReference = referenceId.toLowerCase();
  const normalizedSnippet = snippet.toLowerCase();
  const anchorIndex = normalizedSnippet.indexOf(normalizedReference);
  if (anchorIndex < 0) {
    return 0;
  }

  return [...normalizedSnippet.matchAll(/\b1p\d{2,}\b/g)].filter((match) => {
    if (match[0] === normalizedReference) {
      return false;
    }
    return typeof match.index === 'number' && match.index > anchorIndex;
  }).length;
}
