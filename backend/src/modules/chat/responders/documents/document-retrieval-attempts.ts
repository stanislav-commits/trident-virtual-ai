import { DocumentRetrievalResponseDto } from '../../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../../documents/enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../../../documents/enums/document-retrieval-question-type.enum';
import { getDocumentQuestionClassPolicy } from '../../../documents/retrieval/query/document-question-class-policy';
import { ChatSemanticDocumentsRoute } from '../../routing/chat-semantic-router.types';
import {
  isAdministrativeComplianceIntent,
  isMaintenanceRecordIntent,
} from './document-maintenance-intent';

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
  options: { intentText?: string } = {},
): DocumentClassAttempt[] {
  const attempts: DocumentClassAttempt[] = [];
  const intentText = buildIntentText(documentsRoute, options.intentText);
  const administrativeComplianceIntent =
    isAdministrativeComplianceIntent(intentText);

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

  // Maintenance/PMS record asks are no longer answered from documents — they
  // route to the dedicated `pms` chat path (live Tasks register). The retired
  // historical_procedure retrieval attempt was removed here.

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

  const primary = mergeClasses(
    policy.primary,
    manualClassWhenEquipmentSpecific(documentsRoute, policy.primary),
  );
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


/**
 * A procedure or fault question about EQUIPMENT must search the equipment's
 * manual in the same pass as the vessel's own procedures.
 *
 * The step_by_step policy puts SMS procedures, circulars, publications and
 * regulations first and leaves the manual as a fallback. That is right for
 * "what is our blackout procedure" — a question about how this vessel does
 * things — and wrong for "how do I start the generator", where the answer
 * lives in the manufacturer's manual. The fallback never ran either: the SMS
 * pass came back 'strong', and a later attempt only replaces it by beating it.
 * So on 2026-07-30 the crew got the generic engine-room checklist and "refer
 * to the Mase manual held on board", while that manual sat parsed and indexed
 * in the vessel's own library.
 *
 * The trigger is the router naming a piece of equipment — a generator, a
 * watermaker, a gearbox. NOT the crew naming a brand: nobody types "how do I
 * start the Volvo Penta Mase VS 350 SV", they type "how do I start the
 * generator", and there are two of them on board.
 */
function manualClassWhenEquipmentSpecific(
  documentsRoute: ChatSemanticDocumentsRoute,
  primaryClasses: DocumentDocClass[],
): DocumentDocClass[] {
  if (primaryClasses.includes(DocumentDocClass.MANUAL)) return [];

  const equipmentNamed =
    documentsRoute.equipmentOrSystemHints.length > 0 ||
    documentsRoute.manufacturerHints.length > 0 ||
    documentsRoute.modelHints.length > 0;
  if (!equipmentNamed) return [];

  const proceduralQuestion =
    documentsRoute.questionType ===
      DocumentRetrievalQuestionType.STEP_BY_STEP_PROCEDURE ||
    documentsRoute.questionType ===
      DocumentRetrievalQuestionType.TROUBLESHOOTING;

  return proceduralQuestion ? [DocumentDocClass.MANUAL] : [];
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
    ...documentsRoute.contentFocusHints,
    ...documentsRoute.equipmentOrSystemHints,
    ...documentsRoute.manufacturerHints,
    ...documentsRoute.modelHints,
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
