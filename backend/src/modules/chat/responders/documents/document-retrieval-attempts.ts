import { DocumentRetrievalResponseDto } from '../../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../../documents/enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../../../documents/enums/document-retrieval-question-type.enum';
import { getDocumentQuestionClassPolicy } from '../../../documents/retrieval/document-question-class-policy';
import { ChatSemanticDocumentsRoute } from '../../routing/chat-semantic-router.types';

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

  if (shouldTryManualMaintenanceFallback(documentsRoute)) {
    attempts.push({
      reason: 'secondary_fallback',
      candidateDocClasses: [DocumentDocClass.MANUAL],
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

function shouldTryManualMaintenanceFallback(
  documentsRoute: ChatSemanticDocumentsRoute,
): boolean {
  if (
    documentsRoute.questionType !== DocumentRetrievalQuestionType.HISTORICAL_CASE
  ) {
    return false;
  }

  const contentFocus = documentsRoute.contentFocusHints
    .join(' ')
    .toLocaleLowerCase();

  return (
    /\bmaintenance\b/u.test(contentFocus) &&
    /\b(?:next|due|schedule|scheduled|interval|periodic|running hours?)\b/u.test(
      contentFocus,
    )
  );
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
