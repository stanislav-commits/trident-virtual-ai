import { SearchDocumentsDto } from '../../../documents/dto/search-documents.dto';
import { DocumentDocClass } from '../../../documents/enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../../../documents/enums/document-retrieval-question-type.enum';
import { ChatTurnResponderInput } from '../interfaces/chat-turn-responder.types';
import {
  ChatSemanticDocumentComponent,
  ChatSemanticDocumentsRoute,
} from '../../routing/chat-semantic-router.types';
import {
  normalizeDocumentAnswerLanguage,
  normalizeDocumentLanguageHint,
  normalizeDocumentRetrievalQuery,
} from '../../routing/chat-document-retrieval-query';
import { DocumentClassAttempt } from './document-retrieval-attempts';
import { DocumentQueryPlan } from './document-composite-retrieval';
import {
  enrichDocumentSearchQuestion,
  extractRelevantRunningHours,
  isMaintenanceScheduleQuestion,
} from './document-query-enrichment';
import {
  isAdministrativeComplianceIntent,
  isMaintenanceRecordIntent,
} from './document-maintenance-intent';

export function buildDocumentQueryPlan(
  input: ChatTurnResponderInput,
  documentsRoute: ChatSemanticDocumentsRoute,
): DocumentQueryPlan {
  const originalQuestion = input.ask.question;
  const retrievalQuery = normalizeDocumentRetrievalQuery({
    originalQuestion,
    retrievalQuery: documentsRoute.retrievalQuery,
    documentTitleHint: documentsRoute.documentTitleHint,
  });
  const answerLanguage =
    normalizeDocumentAnswerLanguage(documentsRoute.answerLanguage) ??
    normalizeDocumentAnswerLanguage(input.plan.responseLanguage);
  const baseSearchQuestion = retrievalQuery ?? originalQuestion;
  const searchQuestion = enrichDocumentSearchQuestion({
    originalQuestion,
    searchQuestion: baseSearchQuestion,
    messages: input.messages,
  });
  const enriched = searchQuestion !== baseSearchQuestion;
  const contextFacts = buildDocumentQueryContextFacts({
    originalQuestion,
    baseSearchQuestion,
    searchQuestion,
    messages: input.messages,
  });

  return {
    originalQuestion,
    retrievalQuery: enriched ? searchQuestion : retrievalQuery,
    searchQuestion,
    answerLanguage,
    contextFacts,
  };
}

export function buildComponentQueryPlan(
  input: ChatTurnResponderInput,
  parentRoute: ChatSemanticDocumentsRoute,
  component: ChatSemanticDocumentComponent,
): DocumentQueryPlan {
  const originalQuestion = component.question;
  const retrievalQuery = normalizeDocumentRetrievalQuery({
    originalQuestion,
    retrievalQuery: component.retrievalQuery,
    documentTitleHint: component.documentTitleHint,
  });
  const answerLanguage =
    normalizeDocumentAnswerLanguage(parentRoute.answerLanguage) ??
    normalizeDocumentAnswerLanguage(input.plan.responseLanguage);
  const baseSearchQuestion = retrievalQuery ?? originalQuestion;
  const searchQuestion = enrichDocumentSearchQuestion({
    originalQuestion,
    searchQuestion: baseSearchQuestion,
    messages: input.messages,
  });
  const enriched = searchQuestion !== baseSearchQuestion;
  const contextFacts = buildDocumentQueryContextFacts({
    originalQuestion,
    baseSearchQuestion,
    searchQuestion,
    messages: input.messages,
  });

  return {
    originalQuestion,
    retrievalQuery: enriched ? searchQuestion : retrievalQuery,
    searchQuestion,
    answerLanguage,
    contextFacts,
  };
}

export function buildDocumentRetrievalRequest(
  input: ChatTurnResponderInput,
  documentsRoute: ChatSemanticDocumentsRoute,
  shipId: string,
  attempt: DocumentClassAttempt,
  queryPlan: DocumentQueryPlan,
  options: {
    languageContextQuestion?: string;
    requireDocumentTitleMatch?: boolean;
  } = {},
): SearchDocumentsDto {
  const requireDocumentTitleMatch =
    options.requireDocumentTitleMatch === true ||
    attempt.reason === 'title_hint';

  return {
    question: queryPlan.searchQuestion,
    // Assess evidence against the user's RAW message: the decomposer and
    // router both expand asks with extra clauses/keywords, and the lexical
    // evidence assessor punishes verbose questions (each unsupported
    // "specific token" pushes toward no_evidence). The user's own short
    // question is what the evidence actually needs to answer.
    assessmentQuestion:
      input.context.latestUserMessage?.content?.trim() ||
      queryPlan.originalQuestion,
    shipId,
    viewerUserId: input.session.userId,
    candidateDocClasses: attempt.candidateDocClasses,
    questionType:
      resolveRetrievalQuestionType(documentsRoute, attempt, queryPlan) ??
      undefined,
    equipmentOrSystemHints: documentsRoute.equipmentOrSystemHints.length
      ? documentsRoute.equipmentOrSystemHints
      : undefined,
    manufacturerHints: documentsRoute.manufacturerHints.length
      ? documentsRoute.manufacturerHints
      : undefined,
    modelHints: documentsRoute.modelHints.length
      ? documentsRoute.modelHints
      : undefined,
    contentFocusHints: documentsRoute.contentFocusHints.length
      ? documentsRoute.contentFocusHints
      : undefined,
    documentTitleHint: documentsRoute.documentTitleHint ?? undefined,
    requireDocumentTitleMatch: requireDocumentTitleMatch || undefined,
    languageHint:
      normalizeDocumentLanguageHint({
        originalQuestion: options.languageContextQuestion ?? input.ask.question,
        retrievalQuery: queryPlan.retrievalQuery,
        languageHint: documentsRoute.languageHint,
        answerLanguage: queryPlan.answerLanguage,
        documentTitleHint: documentsRoute.documentTitleHint,
      }) ?? undefined,
    allowMultiDocument:
      documentsRoute.multiDocumentLikely ||
      (attempt.candidateDocClasses?.length ?? 0) > 1 ||
      undefined,
    allowWeakEvidence: true,
  };
}

function resolveRetrievalQuestionType(
  documentsRoute: ChatSemanticDocumentsRoute,
  attempt: DocumentClassAttempt,
  queryPlan: DocumentQueryPlan,
): DocumentRetrievalQuestionType | null {
  const intentText = buildIntentText(documentsRoute, queryPlan);

  if (isAdministrativeComplianceIntent(intentText)) {
    return DocumentRetrievalQuestionType.COMPLIANCE_OR_CERTIFICATE;
  }

  const maintenanceRecordIntent = isMaintenanceRecordIntent(intentText);

  if (maintenanceRecordIntent) {
    return attempt.candidateDocClasses?.includes(DocumentDocClass.MANUAL) &&
      hasMaintenanceScheduleFocus(documentsRoute, queryPlan)
      ? DocumentRetrievalQuestionType.EQUIPMENT_REFERENCE
      : DocumentRetrievalQuestionType.HISTORICAL_CASE;
  }

  if (
    documentsRoute.questionType === DocumentRetrievalQuestionType.HISTORICAL_CASE &&
    attempt.candidateDocClasses?.includes(DocumentDocClass.MANUAL) &&
    hasMaintenanceScheduleFocus(documentsRoute, queryPlan)
  ) {
    return DocumentRetrievalQuestionType.EQUIPMENT_REFERENCE;
  }

  return documentsRoute.questionType;
}

function hasMaintenanceScheduleFocus(
  documentsRoute: ChatSemanticDocumentsRoute,
  queryPlan: DocumentQueryPlan,
): boolean {
  const contentFocus = buildIntentText(documentsRoute, queryPlan).toLocaleLowerCase();

  return (
    /\bmaintenance\b/u.test(contentFocus) &&
    /\b(?:next|due|schedule|scheduled|interval|periodic|running hours?)\b/u.test(
      contentFocus,
    )
  );
}

function buildIntentText(
  documentsRoute: ChatSemanticDocumentsRoute,
  queryPlan: DocumentQueryPlan,
): string {
  return [
    queryPlan.originalQuestion,
    queryPlan.retrievalQuery,
    queryPlan.searchQuestion,
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

function buildDocumentQueryContextFacts(input: {
  originalQuestion: string;
  baseSearchQuestion: string;
  searchQuestion: string;
  messages: ChatTurnResponderInput['messages'];
}): DocumentQueryPlan['contextFacts'] {
  const scheduleQuestion = isMaintenanceScheduleQuestion(
    `${input.originalQuestion} ${input.baseSearchQuestion} ${input.searchQuestion}`,
  );

  return {
    maintenanceScheduleQuestion: scheduleQuestion,
    runningHours: scheduleQuestion
      ? extractRelevantRunningHours({
          originalQuestion: input.originalQuestion,
          messages: input.messages,
        })
      : null,
  };
}
