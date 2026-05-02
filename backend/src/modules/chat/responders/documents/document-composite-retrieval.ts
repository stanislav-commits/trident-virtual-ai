import {
  DocumentRetrievalEvidenceQuality,
  DocumentRetrievalResponseDto,
  DocumentRetrievalResultDto,
} from '../../../documents/dto/document-retrieval-response.dto';
import {
  ChatSemanticDocumentComponent,
  ChatSemanticDocumentsRoute,
} from '../../routing/chat-semantic-router.types';
import {
  CompositeDocumentPromptComponent,
} from './document-composite-answer-prompt';
import { DocumentClassAttempt } from './document-retrieval-attempts';

export const MAX_DOCUMENT_COMPOSITE_COMPONENTS = 3;

export interface DocumentQueryPlan {
  originalQuestion: string;
  retrievalQuery: string | null;
  searchQuestion: string;
  answerLanguage: string | null;
}

export interface DocumentCompositeComponentResult {
  component: ChatSemanticDocumentComponent;
  documentsRoute: ChatSemanticDocumentsRoute;
  queryPlan: DocumentQueryPlan;
  retrieval: DocumentRetrievalResponseDto;
  attempts: DocumentClassAttempt[];
  completedAttempt: DocumentClassAttempt | null;
}

export interface CompositeDocumentEvidence {
  mergedRetrieval: DocumentRetrievalResponseDto;
  promptComponents: CompositeDocumentPromptComponent[];
}

export function getValidCompositeComponents(
  documentsRoute: ChatSemanticDocumentsRoute,
): ChatSemanticDocumentComponent[] {
  return (documentsRoute.components ?? [])
    .filter((component) => component.question.trim().length >= 6)
    .slice(0, MAX_DOCUMENT_COMPOSITE_COMPONENTS);
}

export function buildComponentDocumentsRoute(
  parentRoute: ChatSemanticDocumentsRoute,
  component: ChatSemanticDocumentComponent,
): ChatSemanticDocumentsRoute {
  return {
    ...parentRoute,
    mode: 'single',
    questionType: component.questionType ?? parentRoute.questionType,
    candidateDocClasses: component.candidateDocClasses.length
      ? component.candidateDocClasses
      : parentRoute.candidateDocClasses,
    documentTitleHint: component.documentTitleHint,
    retrievalQuery: component.retrievalQuery,
    languageHint: component.languageHint,
    multiDocumentLikely:
      (component.candidateDocClasses.length
        ? component.candidateDocClasses.length
        : parentRoute.candidateDocClasses.length) > 1,
    components: [],
    compositionMode: null,
  };
}

export function buildCompositeEvidence(input: {
  originalQuestion: string;
  shipId: string;
  componentResults: DocumentCompositeComponentResult[];
}): CompositeDocumentEvidence {
  const rankedResults: DocumentRetrievalResultDto[] = [];
  const promptComponents: CompositeDocumentPromptComponent[] = [];
  let nextRank = 1;

  for (const result of input.componentResults) {
    const evidenceItems = result.retrieval.results.map((item) => ({
      ...item,
      rank: nextRank++,
    }));

    rankedResults.push(...evidenceItems);
    promptComponents.push({
      id: result.component.id,
      label: getComponentLabel(result.component),
      question: result.component.question,
      documentTitleHint: result.component.documentTitleHint,
      evidenceQuality: result.retrieval.evidenceQuality,
      answerabilityReason: result.retrieval.answerability.reason,
      evidenceItems,
    });
  }

  const baseRetrieval = input.componentResults[0].retrieval;
  const evidenceQuality = getCompositeEvidenceQuality(input.componentResults);

  return {
    mergedRetrieval: {
      ...baseRetrieval,
      normalizedQuestion: input.originalQuestion,
      shipId: input.shipId,
      evidenceQuality,
      answerability: {
        status: evidenceQuality,
        reason: input.componentResults
          .map(
            (result) =>
              `${getComponentLabel(result.component)}: ${result.retrieval.answerability.reason}`,
          )
          .join(' '),
      },
      results: rankedResults,
    },
    promptComponents,
  };
}

export function getCompositeEvidenceQuality(
  componentResults: DocumentCompositeComponentResult[],
): DocumentRetrievalEvidenceQuality {
  if (
    componentResults.some((result) => result.retrieval.evidenceQuality === 'strong')
  ) {
    return 'strong';
  }

  if (
    componentResults.some((result) => result.retrieval.evidenceQuality === 'weak')
  ) {
    return 'weak';
  }

  return 'none';
}

export function getComponentLabel(
  component: ChatSemanticDocumentComponent,
): string {
  return (
    component.label ??
    component.documentTitleHint ??
    (component.candidateDocClasses.length
      ? component.candidateDocClasses.join(', ')
      : component.id)
  );
}
