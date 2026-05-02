import { DocumentRetrievalResponseDto } from '../../../documents/dto/document-retrieval-response.dto';
import { extractCitedEvidenceRanks } from './document-answer-grounding';

export function buildDocumentContextReferences(
  retrieval: DocumentRetrievalResponseDto,
  answerText?: string,
  groundingStatus: 'grounded' | 'insufficient' = 'grounded',
): Record<string, unknown>[] {
  if (
    groundingStatus !== 'grounded' ||
    !shouldExposeDocumentContextReferences(retrieval)
  ) {
    return [];
  }

  const citedRanks = extractCitedEvidenceRanks(answerText ?? '');
  if (!citedRanks.size) {
    return [];
  }

  return retrieval.results
    .filter((result) => citedRanks.has(result.rank))
    .map((result) => ({
      id: `document-${result.rank}`,
      sourceType: 'document',
      documentId: result.documentId,
      shipId: retrieval.shipId,
      chunkId: result.chunkId,
      score: result.rerankScore,
      pageNumber: result.page ?? undefined,
      snippet: result.snippet,
      sourceTitle: result.filename,
    }));
}

export function shouldExposeDocumentContextReferences(
  retrieval: DocumentRetrievalResponseDto,
): boolean {
  const answerabilityStatus = String(retrieval.answerability.status);

  if (
    retrieval.evidenceQuality === 'none' ||
    answerabilityStatus === 'none' ||
    answerabilityStatus === 'insufficient' ||
    !retrieval.results.length
  ) {
    return false;
  }

  return true;
}
