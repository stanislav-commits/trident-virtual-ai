import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import {
  ChatMessageResponseDto,
  ChatSessionResponseDto,
} from '../dto/chat-response.dto';

/**
 * Pure helpers for the `chat/session` bounded context.
 *
 * Every function here is deterministic, has no Nest/Prisma dependency, and is
 * safe to import from anywhere. The orchestration lives in
 * `ChatSessionService`; this file owns shape conversion only.
 */

export interface ChatSessionCursorPayload {
  updatedAt: string;
  id: string;
}

export const DEFAULT_CHAT_SESSION_PAGE_SIZE = 30;
export const MAX_CHAT_SESSION_PAGE_SIZE = 100;

interface SessionRow {
  id: string;
  title: string | null;
  userId: string;
  shipId: string | null;
  pinnedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export function formatSessionResponse(
  session: SessionRow,
): ChatSessionResponseDto {
  return {
    id: session.id,
    title: session.title ?? undefined,
    userId: session.userId,
    shipId: session.shipId,
    pinnedAt: session.pinnedAt?.toISOString() ?? null,
    isPinned: !!session.pinnedAt,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    deletedAt: session.deletedAt?.toISOString() ?? null,
  };
}

export function formatMessageResponse(message: any): ChatMessageResponseDto {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    ragflowContext: message.ragflowContext ?? null,
    contextReferences: (message.contextReferences || []).map((ref: any) => ({
      id: ref.id,
      shipManualId: ref.shipManualId,
      shipId: ref.shipManual?.shipId ?? null,
      chunkId: ref.chunkId,
      score: ref.score,
      pageNumber: ref.pageNumber,
      snippet: ref.snippet,
      sourceTitle: ref.sourceTitle,
      sourceCategory: ref.shipManual?.category ?? undefined,
      sourceUrl: ref.sourceUrl,
    })),
    createdAt: message.createdAt.toISOString(),
    deletedAt: message.deletedAt?.toISOString() ?? null,
  };
}

export function normalizeSessionPageSize(value?: string | number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return DEFAULT_CHAT_SESSION_PAGE_SIZE;
  }
  return Math.min(MAX_CHAT_SESSION_PAGE_SIZE, Math.max(1, parsed));
}

export function parseSessionCursor(
  value?: string,
): ChatSessionCursorPayload | null {
  if (!value?.trim()) {
    return null;
  }

  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    const payload = JSON.parse(decoded) as Partial<ChatSessionCursorPayload>;
    if (
      !payload ||
      typeof payload.updatedAt !== 'string' ||
      typeof payload.id !== 'string' ||
      !payload.updatedAt.trim() ||
      !payload.id.trim() ||
      Number.isNaN(new Date(payload.updatedAt).getTime())
    ) {
      throw new Error('Invalid chat session cursor');
    }
    return {
      updatedAt: payload.updatedAt,
      id: payload.id,
    };
  } catch (error) {
    throw new BadRequestException(
      `Invalid chat session cursor: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function encodeSessionCursor(session: {
  id: string;
  updatedAt: Date;
}): string {
  return Buffer.from(
    JSON.stringify({
      updatedAt: session.updatedAt.toISOString(),
      id: session.id,
    }),
    'utf8',
  ).toString('base64url');
}

/**
 * Throws ForbiddenException if the requester does not own the session.
 *
 * Note: role is accepted for forward-compatibility (admin-bypass flows are
 * planned), but at the moment ownership is the only access check, mirroring
 * the previous in-line behaviour of `ChatService.validateAccess`.
 */
export function assertSessionAccess(
  session: { userId: string },
  userId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _role: string,
): void {
  if (session.userId !== userId) {
    throw new ForbiddenException('Cannot access this chat session');
  }
}
