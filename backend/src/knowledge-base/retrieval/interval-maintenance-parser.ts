/**
 * Pure helpers for parsing interval-based maintenance schedules from both
 * plain-text (narrative) and PDF-based (structured table) sources.
 *
 * Every exported function is deterministic and has no Nest / Prisma / Ragflow
 * dependency. The owning scan service passes data in, this module gives
 * extracted maintenance items back.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PdfPageTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IntervalHeaderColumn {
  label: string;
  x: number;
  minY: number;
  maxY: number;
}

export interface IntervalMaintenanceSnippet {
  heading?: string;
  intervalLabel: string;
  items: string[];
}

interface ScoredChunkEntry {
  chunk: { id: string; content: string; similarity?: number; meta?: Record<string, unknown> };
  score: number;
  pageNumber?: number;
  minY?: number;
}

// ---------------------------------------------------------------------------
// Narrative parsing
// ---------------------------------------------------------------------------

export function buildNarrativeIntervalMaintenanceSnippetFromChunks(
  snippets: string[],
  query: string,
  intervalPhrases: string[],
): string | null {
  const combined = snippets.join('\n');
  const extracted = extractNarrativeIntervalMaintenanceSnippet(
    combined,
    query,
    intervalPhrases,
  );
  return extracted ? renderIntervalMaintenanceSnippet(extracted) : null;
}

export function extractNarrativeIntervalMaintenanceSnippet(
  text: string,
  query: string,
  intervalPhrases: string[],
): IntervalMaintenanceSnippet | null {
  const normalizedText = prepareNarrativeIntervalMaintenanceText(text);
  if (!normalizedText) {
    return null;
  }

  const headingPattern =
    /(?:^|\n)\s*((?:\d+(?:\.\d+)+\s*)?(?:(?:daily|weekly|monthly|annual|annually|yearly)\s+(?:operations?|maintenance|checks?|service|inspection)?|once\s+per\s+(?:day|week|month|year)(?:\s*\([^)]*\))?|every\s+\d{1,6}\s*(?:h(?:ours?|rs?)?|hours?|months?|years?)[^:\n]{0,80}|(?:operations?\s+to\s+be\s+carried\s+out\s+after|after)\s+the\s+first\s+\d{1,6}[^:\n]{0,80}|first\s+check\s+after\s+\d{1,6}[^:\n]{0,80}|maintenance\s+as\s+needed|as\s+needed)[^:\n]{0,80}:?)/gi;
  const matches = [...normalizedText.matchAll(headingPattern)];
  if (matches.length === 0) {
    return null;
  }

  const sections = matches
    .map((match, index) => {
      const heading = normalizeNarrativeIntervalHeading(match[1] ?? '');
      const start = (match.index ?? 0) + match[0].length;
      const end =
        index + 1 < matches.length
          ? (matches[index + 1].index ?? normalizedText.length)
          : normalizedText.length;
      return {
        heading,
        body: normalizedText.slice(start, end),
        score: scoreNarrativeIntervalHeading(heading, query, intervalPhrases),
      };
    })
    .filter((section) => section.heading && section.score > 0)
    .sort((left, right) => right.score - left.score);
  const selected = sections[0];
  if (!selected) {
    return null;
  }

  const items = extractNarrativeIntervalMaintenanceItems(selected.body);
  if (items.length === 0) {
    return null;
  }

  return {
    heading: selected.heading,
    intervalLabel: selected.heading,
    items,
  };
}

export function prepareNarrativeIntervalMaintenanceText(text: string): string {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/(\d+(?:\.\d+)+)([A-Za-z])/g, '$1 $2')
    .replace(/[\u2022\u00b7]\s*/g, '\n- ')
    .replace(
      /\s+(?=(?:\d+(?:\.\d+)+\s*)?(?:Daily|Weekly|Monthly|Annual|Annually|Yearly|Once\s+per|Every\s+\d|After\s+the\s+first|Operations?\s+to\s+be\s+carried\s+out\s+after|First\s+check\s+after|Maintenance\s+as\s+needed|As\s+needed)\b)/g,
      '\n',
    )
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function normalizeNarrativeIntervalHeading(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\s+:/g, ':').trim();
}

function scoreNarrativeIntervalHeading(
  heading: string,
  query: string,
  intervalPhrases: string[],
): number {
  const normalizedHeading = heading.toLowerCase();
  const normalizedQuery = query.toLowerCase();
  let score = 0;

  for (const phrase of intervalPhrases) {
    if (normalizedHeading.includes(phrase.toLowerCase())) {
      score += phrase.length > 8 ? 24 : 18;
    }
  }

  if (/\bweekly\b/i.test(normalizedQuery) && /\bweekly\b/i.test(heading)) {
    score += 30;
  }
  if (/\bdaily\b/i.test(normalizedQuery) && /\bdaily\b/i.test(heading)) {
    score += 30;
  }
  if (/\bmonthly\b/i.test(normalizedQuery) && /\bmonthly\b/i.test(heading)) {
    score += 30;
  }
  if (
    /\bannual|annually|yearly\b/i.test(normalizedQuery) &&
    /\b(annual|annually|yearly|once\s+per\s+year)\b/i.test(heading)
  ) {
    score += 30;
  }
  if (
    /\bas\s+needed\b/i.test(normalizedQuery) &&
    /\bas\s+needed\b/i.test(heading)
  ) {
    score += 30;
  }

  for (const target of extractIntervalTargets(query)) {
    if (!normalizedHeading.includes(String(target.value))) {
      continue;
    }
    if (
      target.unit === 'hour' &&
      /\b(h(?:ours?|rs?)?|hourly)\b/i.test(normalizedHeading)
    ) {
      score += 24;
    } else if (
      target.unit === 'month' &&
      /\bmonths?\b/i.test(normalizedHeading)
    ) {
      score += 24;
    } else if (
      target.unit === 'year' &&
      /\byears?\b/i.test(normalizedHeading)
    ) {
      score += 24;
    }
  }

  return score;
}

function extractNarrativeIntervalMaintenanceItems(body: string): string[] {
  const unique = new Set<string>();
  const lines = body
    .replace(/\s+(?=-\s+)/g, '\n')
    .split(/\n+/)
    .map((line) =>
      normalizeIntervalMaintenanceItemDescription(
        line
          .replace(/^[-*]\s*/, '')
          .replace(/\s+/g, ' ')
          .replace(/\s+([,.;:!?])/g, '$1')
          .trim(),
      ),
    )
    .filter(Boolean);

  for (const line of lines) {
    if (isLikelyNarrativeIntervalHeading(line)) {
      continue;
    }
    if (
      !/\b(check|replace|drain|clean|inspect|verify|test|adjust|top\s+up|carry\s+out|rotate|run|fill|reset|remove)\b/i.test(
        line,
      )
    ) {
      continue;
    }
    unique.add(line.replace(/[.;]\s*$/g, '').trim());
    if (unique.size >= 12) {
      break;
    }
  }

  return [...unique];
}

function isLikelyNarrativeIntervalHeading(text: string): boolean {
  return /^(?:\d+(?:\.\d+)+\s*)?(?:daily|weekly|monthly|annual|annually|yearly|every\s+\d|once\s+per|after\s+the\s+first|operations?\s+to\s+be\s+carried\s+out|maintenance\s+as\s+needed|as\s+needed)\b/i.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// Structured PDF table parsing
// ---------------------------------------------------------------------------

export function extractIntervalMaintenanceItemsFromTextItems(
  textItems: PdfPageTextItem[],
  query: string,
  intervalPhrases: string[],
): IntervalMaintenanceSnippet | null {
  if (textItems.length === 0) {
    return null;
  }

  const headerSeedItems = textItems.filter((item) =>
    isLikelyIntervalHeaderText(item.text),
  );
  if (headerSeedItems.length === 0) {
    return null;
  }
  const headerBoundaryItems = headerSeedItems.filter(
    (item) => !isLikelyIntervalTableTitleText(item.text),
  );
  const headerBottomY =
    Math.min(
      ...(headerBoundaryItems.length > 0
        ? headerBoundaryItems
        : headerSeedItems
      ).map((item) => item.y),
    ) - 8;
  const headerItems = textItems.filter((item) => item.y >= headerBottomY);
  const headerColumns = extractIntervalHeaderColumns(headerItems);
  const targetColumn = selectTargetIntervalHeaderColumn(
    headerColumns,
    query,
    intervalPhrases,
  );
  if (!targetColumn) {
    return null;
  }

  const sortedColumns = [...headerColumns].sort(
    (left, right) => left.x - right.x,
  );
  const targetIndex = sortedColumns.findIndex(
    (column) =>
      column.x === targetColumn.x && column.label === targetColumn.label,
  );
  if (targetIndex < 0) {
    return null;
  }

  const leftBoundary =
    targetIndex === 0
      ? targetColumn.x - 20
      : (sortedColumns[targetIndex - 1].x + targetColumn.x) / 2;
  const rightBoundary =
    targetIndex === sortedColumns.length - 1
      ? targetColumn.x + 20
      : (targetColumn.x + sortedColumns[targetIndex + 1].x) / 2;
  const firstIntervalBoundary = Math.max(0, sortedColumns[0].x - 24);

  const rowClusters = clusterPdfRows(
    textItems.filter((item) => item.y < headerBottomY),
    3.5,
  );
  const rawRows = rowClusters
    .map((rowItems) => {
      const sortedRowItems = [...rowItems].sort(
        (left, right) => left.x - right.x,
      );
      const description = normalizeIntervalMaintenanceItemDescription(
        normalizePdfExtractedText(
          sortedRowItems
            .filter(
              (item) =>
                item.x < leftBoundary - 8 && !isIntervalTableMarker(item.text),
            )
            .map((item) => item.text),
        ),
      );
      if (!description) {
        return null;
      }

      const hasTargetMarker = sortedRowItems.some(
        (item) =>
          isIntervalTableMarker(item.text) &&
          item.x >= leftBoundary &&
          item.x < rightBoundary,
      );
      const hasAnyIntervalMarker = sortedRowItems.some(
        (item) =>
          isIntervalTableMarker(item.text) &&
          item.x >= firstIntervalBoundary,
      );
      const isSectionHeading =
        !hasAnyIntervalMarker &&
        isLikelyIntervalTableSectionHeading(description);

      return {
        description,
        hasTargetMarker,
        hasAnyIntervalMarker,
        isSectionHeading,
      };
    })
    .filter(
      (
        row,
      ): row is {
        description: string;
        hasTargetMarker: boolean;
        hasAnyIntervalMarker: boolean;
        isSectionHeading: boolean;
      } => row !== null,
    );

  const logicalRows: Array<{
    description: string;
    hasTargetMarker: boolean;
    hasAnyIntervalMarker: boolean;
    isSectionHeading: boolean;
  }> = [];

  for (const row of rawRows) {
    const previous = logicalRows[logicalRows.length - 1];
    if (
      previous &&
      shouldMergeIntervalTableContinuation(previous.description, row)
    ) {
      previous.description = normalizePdfExtractedText([
        previous.description,
        row.description,
      ]);
      previous.description = normalizeIntervalMaintenanceItemDescription(
        previous.description,
      );
      previous.hasTargetMarker ||= row.hasTargetMarker;
      previous.hasAnyIntervalMarker ||= row.hasAnyIntervalMarker;
      continue;
    }

    logicalRows.push({ ...row });
  }

  const items = [
    ...new Set(
      logicalRows
        .filter((row) => row.hasTargetMarker && !row.isSectionHeading)
        .map((row) => row.description)
        .filter((value) => value.length > 0),
    ),
  ];
  if (items.length === 0) {
    return null;
  }

  return {
    heading: extractIntervalTableHeading(textItems),
    intervalLabel: targetColumn.label,
    items,
  };
}

function extractIntervalHeaderColumns(
  headerItems: PdfPageTextItem[],
): IntervalHeaderColumn[] {
  const clusters = new Map<
    number,
    {
      items: PdfPageTextItem[];
      xs: number[];
    }
  >();

  const sortedItems = [...headerItems].sort(
    (left, right) => left.x - right.x,
  );
  for (const item of sortedItems) {
    const clusterKey = [...clusters.keys()].find(
      (existingX) => Math.abs(existingX - item.x) <= 18,
    );
    const key = clusterKey ?? item.x;
    const cluster = clusters.get(key) ?? { items: [], xs: [] };
    cluster.items.push(item);
    cluster.xs.push(item.x);
    clusters.set(key, cluster);
  }

  return [...clusters.values()]
    .map((cluster) => {
      const items = [...cluster.items].sort((left, right) => {
        if (right.y !== left.y) {
          return right.y - left.y;
        }
        return left.x - right.x;
      });
      const label = normalizePdfExtractedText(
        items.map((item) => item.text),
      );
      return {
        label,
        x:
          cluster.xs.reduce((sum, value) => sum + value, 0) /
          Math.max(cluster.xs.length, 1),
        minY: Math.min(...items.map((item) => item.y)),
        maxY: Math.max(...items.map((item) => item.y)),
      };
    })
    .filter((column) =>
      /^(?:before(?:\s+starting)?|first\s+check(?:\s+after(?:\s+\d+\s+hours?)?)?|every\s+\d{1,4}|\d{1,4}|maintenance\s+as\s+needed|as\s+needed)\b/i.test(
        column.label,
      ),
    )
    .sort((left, right) => left.x - right.x);
}

function selectTargetIntervalHeaderColumn(
  headerColumns: IntervalHeaderColumn[],
  query: string,
  intervalPhrases: string[],
): IntervalHeaderColumn | null {
  const targets = extractIntervalTargets(query);
  const scored = headerColumns
    .map((column) => ({
      column,
      score: scoreIntervalHeaderColumn(
        column.label,
        targets,
        intervalPhrases,
      ),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.column.x - right.column.x,
    );

  return (scored[0]?.score ?? 0) > 0 ? scored[0].column : null;
}

export function extractIntervalTargets(
  query: string,
): Array<{ value: number; unit: 'hour' | 'month' | 'year' }> {
  const targets: Array<{ value: number; unit: 'hour' | 'month' | 'year' }> =
    [];

  for (const match of query.matchAll(
    /\b(\d{1,6})(?:\s*-\s*|\s+)?(h(?:ours?|rs?)?|hourly)\b/gi,
  )) {
    targets.push({ value: Number.parseInt(match[1], 10), unit: 'hour' });
  }
  for (const match of query.matchAll(
    /\b(\d{1,4})(?:\s*-\s*|\s+)?months?\b/gi,
  )) {
    targets.push({ value: Number.parseInt(match[1], 10), unit: 'month' });
  }
  for (const match of query.matchAll(
    /\b(\d{1,4})(?:\s*-\s*|\s+)?years?\b/gi,
  )) {
    targets.push({ value: Number.parseInt(match[1], 10), unit: 'year' });
  }

  return targets.filter((target) => Number.isFinite(target.value));
}

function scoreIntervalHeaderColumn(
  label: string,
  targets: Array<{ value: number; unit: 'hour' | 'month' | 'year' }>,
  intervalPhrases: string[],
): number {
  const normalizedLabel = label.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalizedLabel) {
    return 0;
  }

  let score = 0;
  for (const target of targets) {
    const targetValue = String(target.value);
    if (!normalizedLabel.includes(targetValue)) {
      continue;
    }

    if (
      target.unit === 'hour' &&
      /\b(h(?:ours?|rs?)?|hourly)\b/i.test(normalizedLabel)
    ) {
      score += 18;
    } else if (
      target.unit === 'month' &&
      /\bmonths?\b/i.test(normalizedLabel)
    ) {
      score += 18;
    } else if (
      target.unit === 'year' &&
      /\byears?\b/i.test(normalizedLabel)
    ) {
      score += 18;
    } else {
      score += 6;
    }

    if (/\bevery\b/i.test(normalizedLabel)) {
      score += 4;
    }
  }

  for (const phrase of intervalPhrases) {
    if (normalizedLabel.includes(phrase.toLowerCase())) {
      score += 5;
    }
  }

  if (/\bmaintenance\s+as\s+needed\b/i.test(normalizedLabel)) {
    score -= 4;
  }

  return score;
}

export function clusterPdfRows(
  items: PdfPageTextItem[],
  tolerance: number,
): PdfPageTextItem[][] {
  const rows: Array<{ y: number; items: PdfPageTextItem[] }> = [];
  const sorted = [...items].sort((left, right) => {
    if (right.y !== left.y) {
      return right.y - left.y;
    }
    return left.x - right.x;
  });

  for (const item of sorted) {
    const existingRow = rows.find(
      (row) => Math.abs(row.y - item.y) <= tolerance,
    );
    if (existingRow) {
      existingRow.items.push(item);
      existingRow.y =
        (existingRow.y * (existingRow.items.length - 1) + item.y) /
        existingRow.items.length;
      continue;
    }

    rows.push({ y: item.y, items: [item] });
  }

  return rows.sort((left, right) => right.y - left.y).map((row) => row.items);
}

function isIntervalTableMarker(text: string): boolean {
  return /^[•·●▪■]$/.test(text.trim());
}

function isLikelyIntervalHeaderText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return false;
  }

  return (
    /^(?:\d+\.\d+\s+periodic\s+checks?\s+and\s+maintenance|periodic\s+checks?\s+and\s+maintenance|perform\s+service\s+at\s+intervals\s+indicated)$/i.test(
      normalized,
    ) ||
    /^(?:before(?:\s+starting)?|first\s+check(?:\s+after\s+\d+\s+hours?)?|check|after\s+\d+|hours?|month|months|maintenance|as\s+needed|needed)$/i.test(
      normalized,
    ) ||
    /^every\s+\d{1,4}(?:\s*h(?:ours?|rs?)?\.?\s*or\s*\d+\s*(?:month|months|year|years))?$/i.test(
      normalized,
    ) ||
    /^hrs?\.?\s*or\s*\d+\s*(?:month|months|year|years)$/i.test(normalized)
  );
}

function isLikelyIntervalTableTitleText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return /\bperiodic\s+checks?\s+and\s+maintenance\b/i.test(normalized);
}

function isLikelyIntervalTableSectionHeading(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return false;
  }

  if (normalized.length > 48 || /[.:]/.test(normalized)) {
    return false;
  }

  return /^[A-Z][A-Za-z/&\s-]{2,}$/.test(normalized);
}

function shouldMergeIntervalTableContinuation(
  previousDescription: string,
  row: {
    description: string;
    hasTargetMarker: boolean;
    hasAnyIntervalMarker: boolean;
    isSectionHeading: boolean;
  },
): boolean {
  if (row.isSectionHeading) {
    return false;
  }

  const normalized = row.description.trim();
  if (!normalized) {
    return false;
  }

  const looksLikeContinuation =
    /^[a-z(]/.test(normalized) ||
    previousDescription.endsWith('(') ||
    previousDescription.endsWith('/') ||
    previousDescription.endsWith('-') ||
    previousDescription.endsWith('"');
  if (!looksLikeContinuation) {
    return false;
  }

  if (!row.hasAnyIntervalMarker) {
    return true;
  }

  return !/[.;:]$/.test(previousDescription.trim());
}

function extractIntervalTableHeading(
  textItems: PdfPageTextItem[],
): string | undefined {
  const headingItems = textItems.filter((item) =>
    /\b(periodic\s+checks?\s+and\s+maintenance|perform\s+service\s+at\s+intervals\s+indicated)\b/i.test(
      item.text,
    ),
  );
  if (headingItems.length === 0) {
    return undefined;
  }

  return normalizePdfExtractedText(
    headingItems
      .sort((left, right) => {
        if (right.y !== left.y) {
          return right.y - left.y;
        }
        return left.x - right.x;
      })
      .map((item) => item.text),
  );
}

// ---------------------------------------------------------------------------
// Text normalisation shared by both narrative & PDF paths
// ---------------------------------------------------------------------------

export function normalizePdfExtractedText(parts: string[]): string {
  return parts
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+\/\s+/g, ' / ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function normalizeIntervalMaintenanceItemDescription(
  text: string,
): string {
  return text
    .replace(/\s+[a-z](?=\s*\()/gi, '')
    .replace(/\s+[a-z]$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function renderIntervalMaintenanceSnippet(
  extracted: IntervalMaintenanceSnippet,
): string {
  const lines: string[] = [];
  if (extracted.heading) {
    lines.push(extracted.heading);
  }
  lines.push(`Items due at ${extracted.intervalLabel}:`);
  lines.push(...extracted.items.map((item) => `- ${item}`));
  return lines.join('\n').slice(0, 3600);
}

// ---------------------------------------------------------------------------
// Chunk selection & sorting for interval maintenance page groups
// ---------------------------------------------------------------------------

export function selectBestIntervalMaintenancePageChunks(
  scoredChunks: ScoredChunkEntry[],
): {
  bestChunk: ScoredChunkEntry;
  selectedChunks: ScoredChunkEntry[];
  citationPageNumber?: number;
} {
  const bestChunk = scoredChunks[0];
  if (bestChunk.pageNumber === undefined) {
    return {
      bestChunk,
      selectedChunks: sortIntervalMaintenanceChunks(
        scoredChunks.filter((entry) => entry.score >= bestChunk.score - 4),
      ).slice(0, 8),
      citationPageNumber: undefined,
    };
  }

  const pageGroups = new Map<number, ScoredChunkEntry[]>();
  for (const entry of scoredChunks) {
    if (entry.pageNumber === undefined) {
      continue;
    }
    const group = pageGroups.get(entry.pageNumber) ?? [];
    group.push(entry);
    pageGroups.set(entry.pageNumber, group);
  }

  const rankedGroups = [...pageGroups.entries()]
    .map(([pageNumber, entries]) => {
      const sortedEntries = sortIntervalMaintenanceChunks(entries);
      const strongestScore = sortedEntries[0]?.score ?? 0;
      const nearTopEntries = sortedEntries.filter(
        (entry) => entry.score >= strongestScore - 4,
      );
      const aggregateScore = nearTopEntries.reduce(
        (total, entry) => total + entry.score,
        0,
      );

      return {
        pageNumber,
        strongestScore,
        aggregateScore,
        nearTopEntries,
        sortedEntries,
      };
    })
    .sort((left, right) => {
      if (right.strongestScore !== left.strongestScore) {
        return right.strongestScore - left.strongestScore;
      }
      if (right.aggregateScore !== left.aggregateScore) {
        return right.aggregateScore - left.aggregateScore;
      }
      if (right.nearTopEntries.length !== left.nearTopEntries.length) {
        return right.nearTopEntries.length - left.nearTopEntries.length;
      }
      return right.pageNumber - left.pageNumber;
    });

  const bestGroup = rankedGroups[0];
  if (!bestGroup) {
    return {
      bestChunk,
      selectedChunks: sortIntervalMaintenanceChunks(
        scoredChunks.filter((entry) => entry.score >= bestChunk.score - 4),
      ).slice(0, 8),
      citationPageNumber: bestChunk.pageNumber,
    };
  }

  return {
    bestChunk: bestGroup.sortedEntries[0],
    selectedChunks: sortIntervalMaintenanceChunks(
      bestGroup.nearTopEntries,
    ).slice(0, 8),
    citationPageNumber: bestGroup.pageNumber,
  };
}

export function sortIntervalMaintenanceChunks(
  entries: ScoredChunkEntry[],
): ScoredChunkEntry[] {
  return [...entries].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    if (
      left.minY !== undefined &&
      right.minY !== undefined &&
      left.minY !== right.minY
    ) {
      return left.minY - right.minY;
    }
    if (
      left.pageNumber !== undefined &&
      right.pageNumber !== undefined &&
      left.pageNumber !== right.pageNumber
    ) {
      return left.pageNumber - right.pageNumber;
    }
    return left.chunk.id.localeCompare(right.chunk.id);
  });
}

// ---------------------------------------------------------------------------
// PDF page loading (async - requires pdfjs-dist)
// ---------------------------------------------------------------------------

let pdfJsModulePromise: Promise<any> | null = null;

export async function loadPdfPageTextItems(
  buffer: Buffer,
  pageNumber: number,
): Promise<PdfPageTextItem[]> {
  const pdfjs = await loadPdfJsModule();
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableWorker: true,
    isEvalSupported: false,
  });
  const document = await loadingTask.promise;

  try {
    if (pageNumber < 1 || pageNumber > document.numPages) {
      return [];
    }

    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();

    return textContent.items
      .filter(
        (
          item,
        ): item is {
          str: string;
          transform: number[];
          width?: number;
          height?: number;
        } => typeof item?.str === 'string' && Array.isArray(item.transform),
      )
      .map((item) => ({
        text: item.str,
        x: Number(item.transform[4] ?? 0),
        y: Number(item.transform[5] ?? 0),
        width: Number(item.width ?? 0),
        height: Number(item.height ?? 0),
      }))
      .filter((item) => item.text.trim().length > 0);
  } finally {
    await document.destroy?.();
  }
}

function loadPdfJsModule(): Promise<any> {
  if (!pdfJsModulePromise) {
    pdfJsModulePromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }

  return pdfJsModulePromise;
}
