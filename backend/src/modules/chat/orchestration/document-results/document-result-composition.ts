import { ChatTurnAskResult } from '../../responders/interfaces/chat-turn-responder.types';
import { extractCitedEvidenceRanks } from '../../responders/documents/document-answer-grounding';

export function composeDocumentOnlyResults(
  askResults: ChatTurnAskResult[],
): {
  content: string;
  contextReferences: unknown[];
} {
  let nextRank = 1;
  const contextReferences: unknown[] = [];
  const sections: string[] = [];

  for (const result of askResults) {
    const renumbered = renumberDocumentResultCitations(
      result.summary,
      result.contextReferences ?? [],
      nextRank,
    );

    nextRank = renumbered.nextRank;
    contextReferences.push(...renumbered.contextReferences);
    sections.push([result.question, renumbered.summary].filter(Boolean).join('\n'));
  }

  return {
    content: sections.join('\n\n'),
    contextReferences,
  };
}

export function filterContextReferencesForAnswer(
  content: string,
  contextReferences: unknown[],
): unknown[] {
  const citedRanks = extractCitedEvidenceRanks(content);

  if (!citedRanks.size) {
    return [];
  }

  return contextReferences.filter((reference) => {
    const rank = getDocumentReferenceRank(reference);

    return rank !== null && citedRanks.has(rank);
  });
}

function renumberDocumentResultCitations(
  summary: string,
  contextReferences: unknown[],
  startRank: number,
): {
  summary: string;
  contextReferences: unknown[];
  nextRank: number;
} {
  const citedRanks = extractCitedEvidenceRanks(summary);
  const referencesByRank = new Map<number, unknown>();

  for (const reference of contextReferences) {
    const rank = getDocumentReferenceRank(reference);

    if (rank !== null && citedRanks.has(rank)) {
      referencesByRank.set(rank, reference);
    }
  }

  const rankMap = new Map<number, number>();
  let nextRank = startRank;

  for (const rank of Array.from(citedRanks).sort((a, b) => a - b)) {
    if (!referencesByRank.has(rank)) {
      continue;
    }

    rankMap.set(rank, nextRank);
    nextRank += 1;
  }

  const renumberedSummary = summary.replace(/\[(\d{1,2})\]/g, (match, raw) => {
    const newRank = rankMap.get(Number.parseInt(raw, 10));

    return newRank ? `[${newRank}]` : match;
  });
  const renumberedReferences = Array.from(rankMap.entries()).map(
    ([oldRank, newRank]) =>
      withDocumentReferenceRank(referencesByRank.get(oldRank), newRank),
  );

  return {
    summary: renumberedSummary,
    contextReferences: renumberedReferences,
    nextRank,
  };
}

function getDocumentReferenceRank(reference: unknown): number | null {
  if (!reference || typeof reference !== 'object') {
    return null;
  }

  const id = (reference as Record<string, unknown>).id;

  if (typeof id !== 'string') {
    return null;
  }

  const match = /^document-(\d{1,2})$/.exec(id);
  const rank = Number.parseInt(match?.[1] ?? '', 10);

  return Number.isInteger(rank) && rank > 0 ? rank : null;
}

function withDocumentReferenceRank(reference: unknown, rank: number): unknown {
  if (!reference || typeof reference !== 'object') {
    return reference;
  }

  return {
    ...(reference as Record<string, unknown>),
    id: `document-${rank}`,
  };
}
