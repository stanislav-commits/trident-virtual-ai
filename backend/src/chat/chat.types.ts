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
