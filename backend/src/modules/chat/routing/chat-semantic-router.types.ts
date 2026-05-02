import { DocumentDocClass } from '../../documents/enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../../documents/enums/document-retrieval-question-type.enum';
import { ChatMetricsAskTimeMode } from '../planning/chat-metrics-ask-time-mode.enum';

export enum ChatSemanticRoute {
  DOCUMENTS = 'documents',
  METRICS = 'metrics',
  WEB = 'web',
  MIXED = 'mixed',
  UNCLEAR = 'unclear',
}

export interface ChatSemanticSourcePolicy {
  allowDocuments: boolean;
  allowMetrics: boolean;
  allowWeb: boolean;
  allowWebFallback: boolean;
  allowMixedComposition: boolean;
}

export type ChatSemanticDocumentsMode = 'single' | 'composite';

export type ChatSemanticDocumentCompositionMode =
  | 'synthesize'
  | 'compare'
  | 'checklist'
  | 'procedure'
  | 'conflicts'
  | 'summarize_by_source';

export interface ChatSemanticDocumentComponent {
  id: string;
  label: string | null;
  question: string;
  retrievalQuery?: string | null;
  questionType: DocumentRetrievalQuestionType | null;
  candidateDocClasses: DocumentDocClass[];
  documentTitleHint: string | null;
  requireDocumentTitleMatch: boolean;
  languageHint: string | null;
}

export interface ChatSemanticDocumentsRoute {
  shipId: string | null;
  mode: ChatSemanticDocumentsMode;
  questionType: DocumentRetrievalQuestionType | null;
  candidateDocClasses: DocumentDocClass[];
  equipmentOrSystemHints: string[];
  manufacturerHints: string[];
  modelHints: string[];
  contentFocusHints: string[];
  documentTitleHint: string | null;
  retrievalQuery?: string | null;
  answerLanguage?: string | null;
  languageHint: string | null;
  multiDocumentLikely: boolean;
  components: ChatSemanticDocumentComponent[];
  compositionMode: ChatSemanticDocumentCompositionMode | null;
}

export interface ChatSemanticMetricsRoute {
  timeMode: ChatMetricsAskTimeMode | null;
  timestamp: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
}

export interface ChatSemanticWebRoute {
  externalKnowledgeExplicit: boolean;
  freshnessRequired: boolean;
}

export interface ChatSemanticRouteDecision {
  route: ChatSemanticRoute;
  confidence: number;
  requiresClarification: boolean;
  clarificationQuestion: string | null;
  sourcePolicy: ChatSemanticSourcePolicy;
  documents: ChatSemanticDocumentsRoute;
  metrics: ChatSemanticMetricsRoute;
  web: ChatSemanticWebRoute;
  internalDebugNote?: string;
}

export interface ChatSemanticRouterInput {
  question: string;
  shipId: string | null;
  responseLanguage: string | null;
}
