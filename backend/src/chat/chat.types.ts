import type {
  DocumentationFollowUpState,
  DocumentationRetrievalTrace,
  DocumentationSemanticQuery,
} from '../semantic/semantic.types';

export interface ChatCitation {
  shipManualId?: string;
  chunkId?: string;
  score?: number;
  pageNumber?: number;
  snippet?: string;
  sourceTitle?: string;
  sourceCategory?: string;
  sourceMetadataCategory?: string;
  sourceMetadataCategoryLabel?: string;
  sourceUrl?: string;
}

export interface ChatHistoryMessage {
  role: string;
  content: string;
  ragflowContext?: unknown;
  contextReferences?: ChatCitation[];
}

export interface ChatSuggestionAction {
  label: string;
  message: string;
  kind?: 'suggestion' | 'all';
}

export type ChatClarificationDomain =
  | 'documentation'
  | 'current_telemetry'
  | 'historical_telemetry';

export type ChatClarificationField =
  | 'subject'
  | 'metric_selection'
  | 'year'
  | 'date'
  | 'time_of_day'
  | 'metric_or_time_window';

export interface ChatClarificationState {
  clarificationDomain: ChatClarificationDomain;
  pendingQuery: string;
  requiredFields?: ChatClarificationField[];
  resolvedFields?: Partial<Record<ChatClarificationField, string>>;
  resolvedSubjectQuery?: string;
}

export interface ChatDocumentationContext {
  previousUserQuery?: string;
  retrievalQuery: string;
  resolvedSubjectQuery?: string;
  answerQuery?: string;
  normalizedQuery?: ChatNormalizedQuery;
  citations: ChatCitation[];
  analysisCitations?: ChatCitation[];
  needsClarification?: boolean;
  clarificationQuestion?: string;
  clarificationReason?: string;
  pendingClarificationQuery?: string;
  clarificationState?: ChatClarificationState;
  clarificationActions?: ChatSuggestionAction[];
  compareBySource?: boolean;
  sourceComparisonTitles?: string[];
  mergeBySource?: boolean;
  sourceMergeTitles?: string[];
  semanticQuery?: DocumentationSemanticQuery;
  documentationFollowUpState?: DocumentationFollowUpState;
  retrievalTrace?: DocumentationRetrievalTrace;
  sourceLockActive?: boolean;
}

export type ChatFollowUpMode =
  | 'standalone'
  | 'follow_up'
  | 'clarification_reply';

export type ChatNormalizedOperation =
  | 'lookup'
  | 'average'
  | 'min'
  | 'max'
  | 'sum'
  | 'trend'
  | 'delta'
  | 'position'
  | 'event';

export type ChatNormalizedSourceHint =
  | 'TELEMETRY'
  | 'DOCUMENTATION'
  | 'CERTIFICATES'
  | 'REGULATION'
  | 'HISTORY'
  | 'ANALYTICS';

export type ChatTimeIntentKind =
  | 'none'
  | 'current'
  | 'historical_point'
  | 'historical_range'
  | 'historical_event';

export interface ChatTimeIntent {
  kind: ChatTimeIntentKind;
  expression?: string;
  relativeAmount?: number;
  relativeUnit?: 'hour' | 'day' | 'week' | 'month';
  absoluteDate?: string;
  eventType?: 'bunkering' | 'fuel_increase';
}

export interface ChatNormalizedQuery {
  rawQuery: string;
  normalizedQuery: string;
  retrievalQuery: string;
  effectiveQuery: string;
  previousUserQuery?: string;
  pendingClarificationQuery?: string;
  clarificationState?: ChatClarificationState;
  followUpMode: ChatFollowUpMode;
  subject?: string;
  asset?: string;
  operation: ChatNormalizedOperation;
  timeIntent: ChatTimeIntent;
  sourceHints: ChatNormalizedSourceHint[];
  isClarificationReply: boolean;
  ambiguityFlags: string[];
}

export type ChatAnswerRoute =
  | 'clarification'
  | 'historical_telemetry'
  | 'current_telemetry'
  | 'deterministic_general'
  | 'deterministic_document'
  | 'deterministic_contact'
  | 'deterministic_certificate'
  | 'analytics_forecast'
  | 'llm_generation';
