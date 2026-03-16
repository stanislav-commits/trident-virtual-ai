export interface ChatCitation {
  shipManualId?: string;
  chunkId?: string;
  score?: number;
  pageNumber?: number;
  snippet?: string;
  sourceTitle?: string;
  sourceUrl?: string;
}

export interface ChatHistoryMessage {
  role: string;
  content: string;
  ragflowContext?: unknown;
}

export interface ChatDocumentationContext {
  previousUserQuery?: string;
  retrievalQuery: string;
  resolvedSubjectQuery?: string;
  answerQuery?: string;
  citations: ChatCitation[];
  needsClarification?: boolean;
  clarificationQuestion?: string;
  clarificationReason?: string;
  pendingClarificationQuery?: string;
  compareBySource?: boolean;
  sourceComparisonTitles?: string[];
}
