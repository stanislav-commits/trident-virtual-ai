export class ChatContextReferenceDto {
  id: string;
  shipManualId?: string;
  chunkId?: string;
  score?: number;
  pageNumber?: number;
  snippet?: string;
  sourceTitle?: string;
  sourceUrl?: string;
}

export class ChatMessageResponseDto {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  contextReferences: ChatContextReferenceDto[];
  createdAt: string;
  deletedAt?: string | null;
}

export class ChatSessionResponseDto {
  id: string;
  title?: string;
  userId: string;
  shipId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
  messages?: ChatMessageResponseDto[];
  messageCount?: number;
}
