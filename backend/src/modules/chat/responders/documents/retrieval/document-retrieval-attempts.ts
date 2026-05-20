import { DocumentRetrievalResponseDto } from '../../../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../../../documents/enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../../../../documents/enums/document-retrieval-question-type.enum';
import { getDocumentQuestionClassPolicy } from '../../../../documents/retrieval/document-question-class-policy';
import { ChatSemanticDocumentsRoute } from '../../../routing/chat-semantic-router.types';
import {
  isAdministrativeComplianceIntent,
  isMaintenanceRecordIntent,
} from './document-maintenance-intent';
import { DocumentIntentPlan } from '../intent/document-intent-plan.types';

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
  options: { intentText?: string; intentPlan?: DocumentIntentPlan | null } = {},
): DocumentClassAttempt[] {
  const attempts: DocumentClassAttempt[] = [];
  const intentText = buildIntentText(documentsRoute, options.intentText);
  const maintenanceRecordIntent = isMaintenanceRecordIntent(intentText);
  const administrativeComplianceIntent =
    isAdministrativeComplianceIntent(intentText);
  const plannedClasses = getPlannedDocumentClasses(options.intentPlan);

  if (documentsRoute.documentTitleHint?.trim()) {
    attempts.push({ reason: 'title_hint' });
  }

  if (
    administrativeComplianceIntent &&
    hasHistoricalProcedureBias(documentsRoute)
  ) {
    const compliancePolicy = getDocumentQuestionClassPolicy(
      DocumentRetrievalQuestionType.COMPLIANCE_OR_CERTIFICATE,
    );

    if (compliancePolicy?.primary.length) {
      attempts.push({
        reason: 'primary',
        candidateDocClasses: compliancePolicy.primary,
      });
    }

    if (compliancePolicy?.secondary.length) {
      attempts.push({
        reason: 'secondary_fallback',
        candidateDocClasses: compliancePolicy.secondary,
      });
    }

    return dedupeAttempts(attempts);
  }

  if (maintenanceRecordIntent) {
    attempts.push({
      reason: 'primary',
      candidateDocClasses: [DocumentDocClass.HISTORICAL_PROCEDURE],
    });

    if (shouldTryManualMaintenanceFallback(documentsRoute, intentText)) {
      attempts.push({
        reason: 'secondary_fallback',
        candidateDocClasses: [DocumentDocClass.MANUAL],
      });
    }

    return dedupeAttempts(attempts);
  }

  if (plannedClasses.length) {
    attempts.push({
      reason: 'primary',
      candidateDocClasses: plannedClasses,
    });
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

  if (shouldTryManualMaintenanceFallback(documentsRoute, intentText)) {
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

export function shouldSkipAttemptForCurrentRetrieval(input: {
  attempt: DocumentClassAttempt;
  current: DocumentRetrievalResponseDto | null;
  intentText: string;
}): boolean {
  if (
    !input.current ||
    !isMaintenanceRecordIntent(input.intentText) ||
    !isManualAttempt(input.attempt)
  ) {
    return false;
  }

  return (
    hasUsableAnswerability(input.current) &&
    input.current.results.some(
      (result) => result.docClass === DocumentDocClass.HISTORICAL_PROCEDURE,
    )
  );
}

function shouldTryManualMaintenanceFallback(
  documentsRoute: ChatSemanticDocumentsRoute,
  intentText: string,
): boolean {
  if (
    documentsRoute.questionType !== DocumentRetrievalQuestionType.HISTORICAL_CASE
    && !isMaintenanceRecordIntent(intentText)
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

function buildIntentText(
  documentsRoute: ChatSemanticDocumentsRoute,
  additionalText = '',
): string {
  return [
    additionalText,
    documentsRoute.retrievalQuery,
    documentsRoute.documentTitleHint,
    ...(documentsRoute.contentFocusHints ?? []),
    ...(documentsRoute.equipmentOrSystemHints ?? []),
    ...(documentsRoute.manufacturerHints ?? []),
    ...(documentsRoute.modelHints ?? []),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

function isManualAttempt(attempt: DocumentClassAttempt): boolean {
  return (
    attempt.candidateDocClasses?.length === 1 &&
    attempt.candidateDocClasses[0] === DocumentDocClass.MANUAL
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

function hasHistoricalProcedureBias(
  documentsRoute: ChatSemanticDocumentsRoute,
): boolean {
  return (
    documentsRoute.questionType === DocumentRetrievalQuestionType.HISTORICAL_CASE ||
    documentsRoute.candidateDocClasses.includes(
      DocumentDocClass.HISTORICAL_PROCEDURE,
    )
  );
}

function getPlannedDocumentClasses(
  intentPlan: DocumentIntentPlan | null | undefined,
): DocumentDocClass[] {
  if (!intentPlan || intentPlan.confidence < 0.2) {
    return [];
  }

  const plannedClasses = [
    ...intentPlan.targetDocClasses,
    ...intentPlan.retrievalQueries.flatMap((query) => query.candidateDocClasses),
  ];

  if (plannedClasses.length) {
    return mergeClasses(plannedClasses, []);
  }

  if (
    intentPlan.answerFormattingHints.structuredPms ||
    !['none', 'unknown'].includes(intentPlan.maintenanceIntent) ||
    ['schedule_due', 'task_list', 'work_scope'].includes(intentPlan.evidenceNeed)
  ) {
    return [DocumentDocClass.HISTORICAL_PROCEDURE];
  }

  if (
    intentPlan.asksForSteps ||
    intentPlan.answerMode === 'procedure' ||
    intentPlan.evidenceNeed === 'procedure_steps' ||
    intentPlan.evidenceNeed === 'technical_reference'
  ) {
    return [DocumentDocClass.MANUAL];
  }

  return [];
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
