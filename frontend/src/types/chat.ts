// Citation data from backend ChatContextReference
export interface ChatContextReferenceDto {
  id: string;
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

export interface ChatRagflowContextDto {
  telemetryShips?: string[];
  noDocumentation?: boolean;
  awaitingClarification?: boolean;
  pendingClarificationQuery?: string;
  clarificationReason?: string;
  clarificationActions?: ChatSuggestionActionDto[];
  resolvedSubjectQuery?: string;
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
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  messages?: ChatMessageDto[];
  messageCount?: number;
}

// Local UI types (may differ from backend DTOs)
export interface Message extends ChatMessageDto {
  isLoading?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  messageCount: number;
  updatedAt: string;
}
