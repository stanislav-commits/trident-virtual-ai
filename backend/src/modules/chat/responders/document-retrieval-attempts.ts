import { DocumentRetrievalResponseDto } from '../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../documents/enums/document-doc-class.enum';
import { getDocumentQuestionClassPolicy } from '../../documents/retrieval/document-question-class-policy';
import { ChatSemanticDocumentsRoute } from '../routing/chat-semantic-router.types';

export interface DocumentClassAttempt {
  reason:
    | 'title_hint'
    | 'primary'
    | 'secondary_fallback'
    | 'router_candidates';
  candidateDocClasses?: DocumentDocClass[];
}

export function buildDocumentClassAttempts(
  documentsRoute: ChatSemanticDocumentsRoute,
): DocumentClassAttempt[] {
  const attempts: DocumentClassAttempt[] = [];

  if (documentsRoute.documentTitleHint?.trim()) {
    attempts.push({ reason: 'title_hint' });
  }

  const policy = getDocumentQuestionClassPolicy(documentsRoute.questionType);

  if (!policy) {
    attempts.push({
      reason: 'router_candidates',
      candidateDocClasses: toOptionalClasses(
        documentsRoute.candidateDocClasses,
      ),
    });

    return dedupeAttempts(attempts);
  }

  const primary = mergeClasses(policy.primary, []);
  const fallback = mergeClasses(policy.secondary, []);

  if (primary.length) {
    attempts.push({
      reason: 'primary',
      candidateDocClasses: primary,
    });
  }

  if (fallback.length) {
    attempts.push({
      reason: 'secondary_fallback',
      candidateDocClasses: fallback,
    });
  }

  if (!attempts.length) {
    attempts.push({
      reason: 'router_candidates',
      candidateDocClasses: toOptionalClasses(
        documentsRoute.candidateDocClasses,
      ),
    });
  }

  return dedupeAttempts(attempts);
}

export function isBetterRetrieval(
  candidate: DocumentRetrievalResponseDto,
  current: DocumentRetrievalResponseDto,
): boolean {
  const candidateRank = getRetrievalQualityRank(candidate);
  const currentRank = getRetrievalQualityRank(current);

  if (candidateRank !== currentRank) {
    return candidateRank > currentRank;
  }

  const candidateAnswerable = hasUsableAnswerability(candidate);
  const currentAnswerable = hasUsableAnswerability(current);

  if (candidateAnswerable !== currentAnswerable) {
    return candidateAnswerable;
  }

  return getTopResultScore(candidate) > getTopResultScore(current);
}

function mergeClasses(
  primaryClasses: DocumentDocClass[],
  additionalClasses: DocumentDocClass[],
): DocumentDocClass[] {
  return Array.from(new Set([...primaryClasses, ...additionalClasses]));
}

function toOptionalClasses(
  candidateDocClasses: DocumentDocClass[],
): DocumentDocClass[] | undefined {
  return candidateDocClasses.length
    ? mergeClasses(candidateDocClasses, [])
    : undefined;
}

function dedupeAttempts(
  attempts: DocumentClassAttempt[],
): DocumentClassAttempt[] {
  const seen = new Set<string>();

  return attempts.filter((attempt) => {
    const key = `${attempt.reason}:${(attempt.candidateDocClasses ?? []).join(',')}`;

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function getRetrievalQualityRank(
  retrieval: DocumentRetrievalResponseDto,
): number {
  if (retrieval.evidenceQuality === 'strong') {
    return 3;
  }

  if (retrieval.evidenceQuality === 'weak') {
    return hasUsableAnswerability(retrieval) ? 2 : 1;
  }

  return 0;
}

function hasUsableAnswerability(
  retrieval: DocumentRetrievalResponseDto,
): boolean {
  const answerabilityStatus = String(retrieval.answerability.status);

  return answerabilityStatus !== 'none' && answerabilityStatus !== 'insufficient';
}

function getTopResultScore(retrieval: DocumentRetrievalResponseDto): number {
  const [topResult] = retrieval.results;

  if (!topResult) {
    return 0;
  }

  return Number.isFinite(topResult.rerankScore)
    ? topResult.rerankScore
    : topResult.retrievalScore ?? 0;
}
