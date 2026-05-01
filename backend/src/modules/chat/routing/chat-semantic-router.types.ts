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

export interface ChatSemanticDocumentsRoute {
  shipId: string | null;
  questionType: DocumentRetrievalQuestionType | null;
  candidateDocClasses: DocumentDocClass[];
  equipmentOrSystemHints: string[];
  manufacturerHints: string[];
  modelHints: string[];
  contentFocusHints: string[];
  documentTitleHint: string | null;
  languageHint: string | null;
  multiDocumentLikely: boolean;
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
