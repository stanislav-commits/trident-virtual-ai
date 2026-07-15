import { formatError } from '../../../common/utils/error.utils';
import { DocumentRetrievalEvidenceQuality } from '../../documents/dto/document-retrieval-response.dto';
import { DocumentDocClass } from '../../documents/enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../../documents/enums/document-retrieval-question-type.enum';
import { ChatTurnPlanAsk } from '../planning/chat-turn-plan.types';
import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import { ChatSemanticRoute } from '../routing/chat-semantic-router.types';
import { ChatTurnAskResult } from '../responders/interfaces/chat-turn-responder.types';
import { buildDocumentFallbackWebQuery } from './chat-document-web-query';
import {
  composeFlowingSourceProse,
  OPEN_SOURCE_WEB_LEAD_IN,
} from './chat-source-aware-answer-formatting';

export type DocumentsWebFallbackCondition =
  | 'if_documents_insufficient'
  | 'if_latest_requested'
  | null;

export type DocumentsWebFallbackAction =
  | 'not_applicable'
  | 'skipped'
  | 'skipped_document_answer_usable'
  | 'executed'
  | 'failed';

export type DocumentsWebFallbackTrigger =
  | 'none'
  | 'insufficient_documents'
  | 'explicit_web_fallback'
  | 'latest_info';

export interface DocumentsWebFallbackDiagnostics {
  requested: boolean;
  automaticFallback: boolean;
  documentsFirst: boolean;
  explicitWebFallback: boolean;
  freshnessRequired: boolean;
  latestInfoIntent: boolean;
  documentsInsufficient: boolean;
  fallbackCondition: DocumentsWebFallbackCondition;
  trigger: DocumentsWebFallbackTrigger;
  action: DocumentsWebFallbackAction;
  reason: string;
  documentEvidenceQuality: DocumentRetrievalEvidenceQuality | null;
  documentGroundingStatus: string | null;
  documentAnswerUsable: boolean;
  documentAnswerUsabilityReason: string;
  shipSpecificCaution: boolean;
  webSearchQuestion: string | null;
  webEvidenceAvailable: boolean | null;
  webSourceCount: number | null;
}

export function evaluateDocumentsWebFallback(input: {
  ask: ChatTurnPlanAsk;
  selectedResponder: ChatTurnResponderKind;
  documentResult: ChatTurnAskResult;
}): DocumentsWebFallbackDiagnostics {
  const documentEvidenceQuality = getDocumentEvidenceQuality(input.documentResult);
  const documentGroundingStatus = getDocumentGroundingStatus(input.documentResult);
  const documentAnswerUsability = assessDocumentAnswerUsability(
    input.documentResult,
  );
  const explicitWebFallback = hasExplicitWebFallbackIntent(input.ask);
  const freshnessRequired = hasFreshnessIntent(input.ask);
  // Weak-but-grounded document answers stay document-only: falling back to
  // the public web on every "weak" verdict made the assistant web-search
  // far too often (user feedback 2026-06-11) and pad answers with generic
  // internet content when the manual already answered. The web fallback is
  // for genuinely empty/ungrounded document results, or explicit requests.
  const documentsInsufficient =
    !documentAnswerUsability.usable &&
    (documentEvidenceQuality === 'none' ||
      documentGroundingStatus === 'insufficient');
  const automaticFallback = documentsInsufficient && !freshnessRequired;
  const requested = explicitWebFallback || freshnessRequired;
  const documentsFirst =
    input.selectedResponder === ChatTurnResponderKind.DOCUMENTS &&
    isDocumentsWebFallbackRoute(input.ask);
  const fallbackCondition = freshnessRequired
    ? 'if_latest_requested'
    : documentsInsufficient
      ? 'if_documents_insufficient'
      : null;
  const trigger = getFallbackTrigger({
    explicitWebFallback,
    freshnessRequired,
    documentsInsufficient,
  });
  const shipSpecificCaution = hasShipSpecificCaution(input.ask);

  if (!documentsFirst) {
    return {
      requested,
      automaticFallback: false,
      documentsFirst,
      explicitWebFallback,
      freshnessRequired,
      latestInfoIntent: freshnessRequired,
      documentsInsufficient,
      fallbackCondition,
      trigger: 'none',
      action: 'not_applicable',
      reason: 'Web fallback is only evaluated for document-primary asks.',
      documentEvidenceQuality,
      documentGroundingStatus,
      documentAnswerUsable: documentAnswerUsability.usable,
      documentAnswerUsabilityReason: documentAnswerUsability.reason,
      shipSpecificCaution,
      webSearchQuestion: null,
      webEvidenceAvailable: null,
      webSourceCount: null,
    };
  }

  if (freshnessRequired) {
    return {
      requested,
      automaticFallback: false,
      documentsFirst,
      explicitWebFallback,
      freshnessRequired,
      latestInfoIntent: freshnessRequired,
      documentsInsufficient,
      fallbackCondition,
      trigger,
      action: 'executed',
      reason:
        'Latest/current external information was requested after ship-document lookup.',
      documentEvidenceQuality,
      documentGroundingStatus,
      documentAnswerUsable: documentAnswerUsability.usable,
      documentAnswerUsabilityReason: documentAnswerUsability.reason,
      shipSpecificCaution,
      webSearchQuestion: null,
      webEvidenceAvailable: null,
      webSourceCount: null,
    };
  }

  if (documentsInsufficient) {
    return {
      requested,
      automaticFallback,
      documentsFirst,
      explicitWebFallback,
      freshnessRequired,
      latestInfoIntent: freshnessRequired,
      documentsInsufficient,
      fallbackCondition,
      trigger,
      action: 'executed',
      reason:
        documentGroundingStatus === 'insufficient'
          ? 'Ship-document answer grounding was insufficient, so web fallback will run after document lookup.'
          : 'Ship documents did not produce a usable grounded answer, so web fallback will run after document lookup.',
      documentEvidenceQuality,
      documentGroundingStatus,
      documentAnswerUsable: documentAnswerUsability.usable,
      documentAnswerUsabilityReason: documentAnswerUsability.reason,
      shipSpecificCaution,
      webSearchQuestion: null,
      webEvidenceAvailable: null,
      webSourceCount: null,
    };
  }

  if (documentAnswerUsability.usable && documentEvidenceQuality !== 'strong') {
    return {
      requested,
      automaticFallback: false,
      documentsFirst,
      explicitWebFallback,
      freshnessRequired,
      latestInfoIntent: freshnessRequired,
      documentsInsufficient,
      fallbackCondition,
      trigger: 'none',
      action: 'skipped_document_answer_usable',
      reason:
        'Ship-document evidence was weak, but the document answer was grounded, cited, and usable, so web fallback was not needed.',
      documentEvidenceQuality,
      documentGroundingStatus,
      documentAnswerUsable: documentAnswerUsability.usable,
      documentAnswerUsabilityReason: documentAnswerUsability.reason,
      shipSpecificCaution,
      webSearchQuestion: null,
      webEvidenceAvailable: null,
      webSourceCount: null,
    };
  }

  return {
    requested,
    automaticFallback: false,
    documentsFirst,
    explicitWebFallback,
    freshnessRequired,
    latestInfoIntent: freshnessRequired,
    documentsInsufficient,
    fallbackCondition,
    trigger: 'none',
    action: 'skipped',
    reason:
      'Ship-document evidence was strong, and no latest/current external-information supplement was requested.',
    documentEvidenceQuality,
    documentGroundingStatus,
    documentAnswerUsable: documentAnswerUsability.usable,
    documentAnswerUsabilityReason: documentAnswerUsability.reason,
    shipSpecificCaution,
    webSearchQuestion: null,
    webEvidenceAvailable: null,
    webSourceCount: null,
  };
}

export function isDocumentsWebFallbackRoute(ask: ChatTurnPlanAsk): boolean {
  const route = ask.semanticRoute;

  if (route.route === ChatSemanticRoute.DOCUMENTS) {
    return true;
  }

  return (
    route.route === ChatSemanticRoute.MIXED &&
    route.sourcePolicy.allowDocuments &&
    route.sourcePolicy.allowWeb &&
    !route.sourcePolicy.allowMetrics
  );
}

export function markDocumentsWebFallbackExecuted(
  diagnostics: DocumentsWebFallbackDiagnostics,
  webResult: ChatTurnAskResult,
  webSearchQuestion: string,
): DocumentsWebFallbackDiagnostics {
  const sourceCount =
    typeof webResult.data?.sourceCount === 'number'
      ? webResult.data.sourceCount
      : (webResult.contextReferences?.length ?? 0);

  return {
    ...diagnostics,
    action: 'executed',
    webSearchQuestion,
    webEvidenceAvailable: sourceCount > 0 || Boolean(webResult.summary.trim()),
    webSourceCount: sourceCount,
  };
}

export function markDocumentsWebFallbackFailed(
  diagnostics: DocumentsWebFallbackDiagnostics,
  error: unknown,
): DocumentsWebFallbackDiagnostics {
  return {
    ...diagnostics,
    action: 'failed',
    reason: `Web fallback failed: ${formatError(error)}`,
    webEvidenceAvailable: false,
    webSourceCount: 0,
  };
}

export function withDocumentsWebFallbackDiagnostics(
  result: ChatTurnAskResult,
  diagnostics: DocumentsWebFallbackDiagnostics,
  webResult?: ChatTurnAskResult,
): ChatTurnAskResult {
  const documentSummary = sanitizeDocumentSummaryForWebFallback(result.summary);

  return {
    ...result,
    capabilityLabel:
      diagnostics.action === 'executed'
        ? 'document retrieval + web fallback'
        : result.capabilityLabel,
    summary: composeDocumentsWebFallbackSummary(result, diagnostics, webResult),
    data: {
      ...(result.data ?? {}),
      webFallback: {
        ...diagnostics,
        documentSummary,
        webSummary: webResult?.summary ?? null,
        webResponder: webResult
          ? {
              responder: webResult.responder,
              capabilityLabel: webResult.capabilityLabel,
              sourceCount:
                typeof webResult.data?.sourceCount === 'number'
                  ? webResult.data.sourceCount
                  : (webResult.contextReferences?.length ?? 0),
            }
          : null,
      },
    },
    contextReferences:
      diagnostics.action === 'executed' && webResult
        ? [
            ...(result.contextReferences ?? []),
            ...(webResult.contextReferences ?? []),
          ]
        : result.contextReferences,
  };
}

export function sanitizeDocumentSummaryForWebFallback(summary: string): string {
  return summary
    .replace(
      /\s*I did not use metrics or web fallback for this document-only request\.\s*/giu,
      ' ',
    )
    .replace(
      /\s*I did not use web fallback for this document-only request\.\s*/giu,
      ' ',
    )
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function isDocumentAnswerUsableForFallbackDecision(
  result: ChatTurnAskResult,
): boolean {
  return assessDocumentAnswerUsability(result).usable;
}

export function getDocumentsWebFallbackDiagnostics(
  result: ChatTurnAskResult,
): DocumentsWebFallbackDiagnostics | null {
  const webFallback =
    result.data &&
    typeof result.data === 'object' &&
    'webFallback' in result.data
      ? result.data.webFallback
      : null;

  return isDocumentsWebFallbackDiagnostics(webFallback) ? webFallback : null;
}

export function buildDocumentsWebFallbackSearchQuestion(input: {
  ask: ChatTurnPlanAsk;
  diagnostics: DocumentsWebFallbackDiagnostics;
  documentResult?: ChatTurnAskResult | null;
}): string {
  const question = buildDocumentFallbackWebQuery({
    ask: input.ask,
    documentResult: input.documentResult,
  });

  if (input.diagnostics.shipSpecificCaution) {
    return [
      `Find general public background information related to: ${question}`,
      'Do not treat web information as vessel-specific, onboard PMS, certificate, equipment-register, or current operational truth.',
      'Prefer manufacturer, official, or authoritative public sources when available.',
    ].join(' ');
  }

  if (input.diagnostics.freshnessRequired) {
    return [
      `Find latest public information related to: ${question}`,
      'Prefer official manufacturer, publisher, regulator, or authoritative sources when available.',
    ].join(' ');
  }

  return [
    `Find public web information related to: ${question}`,
    'Use web information only because uploaded ship-document evidence was insufficient.',
    'Prefer official manufacturer, publisher, regulator, or authoritative sources when available.',
  ].join(' ');
}

function composeDocumentsWebFallbackSummary(
  documentResult: ChatTurnAskResult,
  diagnostics: DocumentsWebFallbackDiagnostics,
  webResult?: ChatTurnAskResult,
): string {
  if (
    diagnostics.action === 'skipped' ||
    diagnostics.action === 'skipped_document_answer_usable' ||
    diagnostics.action === 'not_applicable'
  ) {
    return documentResult.summary;
  }

  const documentSummary = sanitizeDocumentSummaryForWebFallback(
    documentResult.summary,
  );
  return composeFlowingSourceProse(
    [{ summary: documentSummary, repeatedLeadingText: documentResult.question }],
    [{ summary: buildWebFallbackSection(diagnostics, webResult) }],
    // Label the section as open sources only when a web answer actually ran —
    // a 'failed' fallback carries a "couldn't reach public sources" notice, not
    // open-source content, so it must not get the "here's what open sources
    // say" header.
    {
      webLeadIn:
        diagnostics.action === 'executed' ? OPEN_SOURCE_WEB_LEAD_IN : undefined,
    },
  );
}

function buildWebFallbackSection(
  diagnostics: DocumentsWebFallbackDiagnostics,
  webResult?: ChatTurnAskResult,
): string {
  if (diagnostics.action === 'executed' && webResult) {
    // The model's own prose already carries the "this is from public sources,
    // not the vessel's manual" caveat (web-search prompt enforces it). Adding
    // an "I could not confirm... Public sources suggest:" preamble on top
    // gave a clunky double-disclaimer that the user complained about.
    return webResult.summary;
  }

  if (diagnostics.action === 'failed') {
    return `Couldn't reach public sources for this question (${diagnostics.reason}).`;
  }

  return diagnostics.reason;
}

function getFallbackTrigger(input: {
  explicitWebFallback: boolean;
  freshnessRequired: boolean;
  documentsInsufficient: boolean;
}): DocumentsWebFallbackTrigger {
  if (input.freshnessRequired) {
    return 'latest_info';
  }

  if (input.explicitWebFallback) {
    return 'explicit_web_fallback';
  }

  if (input.documentsInsufficient) {
    return 'insufficient_documents';
  }

  return 'none';
}

function getDocumentEvidenceQuality(
  result: ChatTurnAskResult,
): DocumentRetrievalEvidenceQuality | null {
  const retrieval = getNestedRecord(result.data, 'retrieval');
  const evidenceQuality = retrieval?.evidenceQuality;

  if (
    evidenceQuality === 'strong' ||
    evidenceQuality === 'weak' ||
    evidenceQuality === 'none'
  ) {
    return evidenceQuality;
  }

  const status = typeof result.data?.status === 'string' ? result.data.status : null;

  if (status === 'no_evidence' || status === 'retrieval_failed') {
    return 'none';
  }

  if (status === 'weak_evidence') {
    return 'weak';
  }

  if (status === 'answered') {
    return 'strong';
  }

  return null;
}

function getDocumentGroundingStatus(result: ChatTurnAskResult): string | null {
  const retrieval = getNestedRecord(result.data, 'retrieval');
  const answerGrounding = getNestedRecord(retrieval, 'answerGrounding');
  const status = answerGrounding?.status;

  return typeof status === 'string' ? status : null;
}

function assessDocumentAnswerUsability(
  result: ChatTurnAskResult,
): { usable: boolean; reason: string } {
  const evidenceQuality = getDocumentEvidenceQuality(result);
  const groundingStatus = getDocumentGroundingStatus(result);
  const status = typeof result.data?.status === 'string' ? result.data.status : null;
  const summary = sanitizeDocumentSummaryForWebFallback(result.summary);
  const hasContextReferences = (result.contextReferences?.length ?? 0) > 0;
  const hasCitationMarkers = /\[\d{1,2}\]/u.test(summary);

  if (status === 'retrieval_failed' || status === 'missing_ship_context') {
    return { usable: false, reason: `Document responder status was ${status}.` };
  }

  if (evidenceQuality === 'none' || status === 'no_evidence') {
    return {
      usable: false,
      reason: 'Document retrieval found no usable evidence.',
    };
  }

  if (groundingStatus === 'insufficient') {
    return {
      usable: false,
      reason: 'Document answer grounding status was insufficient.',
    };
  }

  if (isInsufficientEvidenceFallbackSummary(summary)) {
    return {
      usable: false,
      reason: 'Document answer was an insufficient-evidence fallback.',
    };
  }

  if (!hasContextReferences && !hasCitationMarkers) {
    return {
      usable: false,
      reason: 'Document answer did not expose document citations or context references.',
    };
  }

  if (!hasMeaningfulAnswerContent(summary)) {
    return {
      usable: false,
      reason: 'Document answer did not contain enough meaningful content.',
    };
  }

  return {
    usable: true,
    reason: 'Document answer was grounded, cited, and contained meaningful content.',
  };
}

function hasExplicitWebFallbackIntent(ask: ChatTurnPlanAsk): boolean {
  const route = ask.semanticRoute;

  return (
    route.sourcePolicy.allowWebFallback ||
    (route.sourcePolicy.allowDocuments && route.sourcePolicy.allowWeb) ||
    route.web.externalKnowledgeExplicit ||
    hasExplicitWebFallbackWording(ask.question)
  );
}

function hasFreshnessIntent(ask: ChatTurnPlanAsk): boolean {
  return ask.semanticRoute.web.freshnessRequired || hasFreshnessWording(ask.question);
}

function hasShipSpecificCaution(ask: ChatTurnPlanAsk): boolean {
  const route = ask.semanticRoute;
  const docClasses = route.documents.candidateDocClasses;
  const questionType = route.documents.questionType;
  const normalized = normalizeQuestion(ask.question);

  return (
    docClasses.includes(DocumentDocClass.HISTORICAL_PROCEDURE) ||
    docClasses.includes(DocumentDocClass.CERTIFICATE) ||
    questionType === DocumentRetrievalQuestionType.HISTORICAL_CASE ||
    questionType === DocumentRetrievalQuestionType.COMPLIANCE_OR_CERTIFICATE ||
    /\b(?:pms|maintenance\s+(?:job|task|record|schedule)|next\s+(?:job|task|maintenance)|overdue|due\s+(?:job|task|maintenance)|certificate|certificates|equipment\s+list|asset\s+register|equipment\s+register|current\s+(?:onboard|ship|vessel|fuel|level|state))\b/u.test(
      normalized,
    )
  );
}

function hasExplicitWebFallbackWording(question: string): boolean {
  const normalized = normalizeQuestion(question);
  const mentionsWeb =
    /\b(?:web|online|internet|external|public|google|search)\b/u.test(
      normalized,
    ) || /\blook\s+up\b/u.test(normalized);
  const fallbackWording =
    /\bif\s+(?:needed|necessary|required|not\s+(?:in|found\s+in)\s+(?:the\s+)?(?:docs?|documents?|manuals?))\b/u.test(
      normalized,
    ) ||
    /\bafter\s+(?:checking|looking\s+in|searching)\s+(?:the\s+)?(?:ship\s+)?(?:docs?|documents?|manuals?)\b/u.test(
      normalized,
    ) ||
    /\b(?:check|search|use)\s+(?:the\s+)?(?:web|online|internet)\b/u.test(
      normalized,
    );

  return mentionsWeb && fallbackWording;
}

function hasFreshnessWording(question: string): boolean {
  const normalized = normalizeQuestion(question);

  return /\b(?:latest|newest|most\s+recent|up[-\s]?to[-\s]?date|current\s+(?:external|online|web|public)?\s*(?:version|info|information|manual)?)\b/u.test(
    normalized,
  );
}

function isInsufficientEvidenceFallbackSummary(summary: string): boolean {
  const normalized = normalizeQuestion(summary);

  return /\b(?:could not find|cannot find|did not find|no relevant|no parsed documents?|no usable|not enough|insufficient|ambiguous|do not clearly support|does not clearly support|did not support|cannot safely|could not safely|not confidently|answer model did not return|not found in (?:the )?(?:uploaded )?(?:ship )?documents?)\b/u.test(
    normalized,
  );
}

function hasMeaningfulAnswerContent(summary: string): boolean {
  const normalized = summary
    .replace(/\[\d{1,2}\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = normalized.match(/\b[\p{L}\p{N}][\p{L}\p{N}'-]*\b/gu) ?? [];

  return normalized.length >= 32 && words.length >= 6;
}

function normalizeQuestion(question: string): string {
  return question.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function getNestedRecord(
  value: Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  const entry = value?.[key];

  return entry && typeof entry === 'object'
    ? (entry as Record<string, unknown>)
    : null;
}

function isDocumentsWebFallbackDiagnostics(
  value: unknown,
): value is DocumentsWebFallbackDiagnostics {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as DocumentsWebFallbackDiagnostics).requested === 'boolean' &&
    typeof (value as DocumentsWebFallbackDiagnostics).automaticFallback ===
      'boolean' &&
    typeof (value as DocumentsWebFallbackDiagnostics).action === 'string'
  );
}


