import { ChatMessageEntity } from './entities/chat-message.entity';
import { ChatSessionEntity } from './entities/chat-session.entity';

export interface ChatContextReferenceResponseDto {
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

export interface ChatMessageResponseDto {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ragflowContext: Record<string, unknown> | null;
  contextReferences: ChatContextReferenceResponseDto[];
  createdAt: string;
  deletedAt: string | null;
}

export interface ChatSessionResponseDto {
  id: string;
  title: string | null;
  userId: string;
  shipId: string | null;
  pinnedAt: string | null;
  isPinned: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  messageCount?: number;
  messages?: ChatMessageResponseDto[];
}

export function toChatMessageResponse(
  entity: ChatMessageEntity,
): ChatMessageResponseDto {
  const {
    contextReferences,
    sanitizedRagflowContext,
  } = extractContextReferences(entity.ragflowContext);

  return {
    id: entity.id,
    role: entity.role,
    content: entity.content,
    ragflowContext: sanitizedRagflowContext,
    contextReferences,
    createdAt: entity.createdAt.toISOString(),
    deletedAt: entity.deletedAt ? entity.deletedAt.toISOString() : null,
  };
}

export function toChatSessionResponse(
  entity: ChatSessionEntity,
  options: {
    messageCount?: number;
    messages?: ChatMessageEntity[];
  } = {},
): ChatSessionResponseDto {
  return {
    id: entity.id,
    title: entity.title,
    userId: entity.userId,
    shipId: entity.shipId,
    pinnedAt: entity.pinnedAt ? entity.pinnedAt.toISOString() : null,
    isPinned: Boolean(entity.pinnedAt),
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
    deletedAt: entity.deletedAt ? entity.deletedAt.toISOString() : null,
    messageCount: options.messageCount,
    messages: options.messages?.map(toChatMessageResponse),
  };
}

function extractContextReferences(ragflowContext: Record<string, unknown> | null): {
  contextReferences: ChatContextReferenceResponseDto[];
  sanitizedRagflowContext: Record<string, unknown> | null;
} {
  if (!ragflowContext || typeof ragflowContext !== 'object') {
    return {
      contextReferences: [],
      sanitizedRagflowContext: ragflowContext,
    };
  }

  const rawContextReferences = (ragflowContext as Record<string, unknown>)
    .contextReferences;
  const { contextReferences: _ignored, ...rest } = ragflowContext;

  if (!Array.isArray(rawContextReferences)) {
    return {
      contextReferences: [],
      sanitizedRagflowContext: Object.keys(rest).length > 0 ? rest : null,
    };
  }

  const contextReferences = rawContextReferences
    .map((value, index) => normalizeContextReference(value, index))
    .filter((value): value is ChatContextReferenceResponseDto => value !== null);

  return {
    contextReferences,
    sanitizedRagflowContext: Object.keys(rest).length > 0 ? rest : null,
  };
}

function normalizeContextReference(
  value: unknown,
  index: number,
): ChatContextReferenceResponseDto | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const entry = value as Record<string, unknown>;
  const id =
    typeof entry.id === 'string' && entry.id.trim().length > 0
      ? entry.id.trim()
      : `ref-${index + 1}`;

  return {
    id,
    shipManualId:
      typeof entry.shipManualId === 'string' ? entry.shipManualId : undefined,
    shipId:
      typeof entry.shipId === 'string' || entry.shipId === null
        ? (entry.shipId as string | null)
        : undefined,
    chunkId: typeof entry.chunkId === 'string' ? entry.chunkId : undefined,
    score: typeof entry.score === 'number' ? entry.score : undefined,
    pageNumber:
      typeof entry.pageNumber === 'number' ? entry.pageNumber : undefined,
    snippet: typeof entry.snippet === 'string' ? entry.snippet : undefined,
    sourceTitle:
      typeof entry.sourceTitle === 'string' ? entry.sourceTitle : undefined,
    sourceUrl:
      typeof entry.sourceUrl === 'string' ? entry.sourceUrl : undefined,
  };
}
