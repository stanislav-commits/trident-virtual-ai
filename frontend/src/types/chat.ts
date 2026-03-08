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

// Message from backend ChatMessage
export interface ChatMessageDto {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  ragflowContext?: Record<string, unknown> | null;
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
