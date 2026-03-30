export interface ChatCitation {
  shipManualId?: string;
  chunkId?: string;
  score?: number;
  pageNumber?: number;
  snippet?: string;
  sourceTitle?: string;
  sourceCategory?: string;
  sourceUrl?: string;
}

export interface ChatHistoryMessage {
  role: string;
  content: string;
  ragflowContext?: unknown;
}

export interface ChatSuggestionAction {
  label: string;
  message: string;
  kind?: 'suggestion' | 'all';
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
  clarificationActions?: ChatSuggestionAction[];
  compareBySource?: boolean;
  sourceComparisonTitles?: string[];
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
  | 'deterministic_document'
  | 'deterministic_contact'
  | 'deterministic_certificate'
  | 'analytics_forecast'
  | 'llm_generation';
