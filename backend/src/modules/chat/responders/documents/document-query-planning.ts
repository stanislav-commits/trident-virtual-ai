import { SearchDocumentsDto } from '../../../documents/dto/search-documents.dto';
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

  return {
    originalQuestion,
    retrievalQuery,
    searchQuestion: retrievalQuery ?? originalQuestion,
    answerLanguage,
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

  return {
    originalQuestion,
    retrievalQuery,
    searchQuestion: retrievalQuery ?? originalQuestion,
    answerLanguage,
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
    shipId,
    candidateDocClasses: attempt.candidateDocClasses,
    questionType: documentsRoute.questionType ?? undefined,
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
