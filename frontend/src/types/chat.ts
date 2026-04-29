// Citation data from backend ChatContextReference
export interface ChatContextReferenceDto {
  id: string;
  sourceType?: "document" | "metric" | "web" | "legacy_manual" | (string & {});
  documentId?: string;
  shipManualId?: string;
  shipId?: string | null;
  chunkId?: string;
  score?: number;
  pageNumber?: number;
  snippet?: string;
  sourceTitle?: string;
  sourceUrl?: string;
}

export interface ChatSuggestionActionDto {
  label: string;
  message: string;
  kind?: "suggestion" | "all";
}

export interface ChatMetricExecutionMemberDto {
  memberId: string;
  role?: string | null;
  sourceType?: "metric";
  metricCatalogId?: string;
  label: string;
  key?: string | null;
  value: unknown;
  unit?: string | null;
  timestamp?: string | null;
  description?: string | null;
  result?: null;
}

export interface ChatMetricExecutionResultDto {
  conceptId: string;
  conceptSlug: string;
  conceptDisplayName: string;
  type: string;
  aggregationRule: string;
  value: unknown;
  unit?: string | null;
  timestamp?: string | null;
  members: ChatMetricExecutionMemberDto[];
  metadata?: Record<string, unknown> | null;
}

export interface ChatMetricExecutionDto {
  query?: string | null;
  ship?: {
    id: string;
    name: string;
    organizationName?: string | null;
  };
  concept: {
    id: string;
    slug: string;
    displayName: string;
    description?: string | null;
    category?: string | null;
    type: string;
    aggregationRule: string;
    unit?: string | null;
  };
  timeMode: string;
  timestamp?: string | null;
  queriedMetricCount: number;
  result: ChatMetricExecutionResultDto;
}

export interface ChatTurnAskResultDto {
  askId: string;
  intent: string;
  responder: string;
  question: string;
  capabilityEnabled: boolean;
  capabilityLabel: string;
  summary: string;
  data?: {
    execution?: ChatMetricExecutionDto;
    status?: string;
    error?: string;
  } | null;
  contextReferences?: ChatContextReferenceDto[];
}

export interface ChatRagflowContextDto {
  telemetryShips?: string[];
  noDocumentation?: boolean;
  awaitingClarification?: boolean;
  pendingClarificationQuery?: string;
  clarificationReason?: string;
  clarificationActions?: ChatSuggestionActionDto[];
  resolvedSubjectQuery?: string;
  askResults?: ChatTurnAskResultDto[];
}

// Message from backend ChatMessage
export interface ChatMessageDto {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ragflowContext?: ChatRagflowContextDto | null;
  contextReferences: ChatContextReferenceDto[];
  createdAt: string;
  deletedAt?: string | null;
}

// Session from backend ChatSession
export interface ChatSessionDto {
  id: string;
  title?: string;
  userId: string;
  shipId: string | null;
  pinnedAt: string | null;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  messages?: ChatMessageDto[];
  messageCount?: number;
}

export interface ChatSessionListDto {
  sessions: ChatSessionDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

// Local UI types (may differ from backend DTOs)
export interface Message extends ChatMessageDto {
  isLoading?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  messageCount: number;
  pinnedAt: string | null;
  isPinned: boolean;
  updatedAt: string;
}
