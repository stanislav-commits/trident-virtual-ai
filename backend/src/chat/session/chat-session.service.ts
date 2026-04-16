import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from '../llm/llm.service';
import { CreateChatSessionDto } from '../dto/create-chat-session.dto';
import {
  ChatMessageResponseDto,
  ChatSessionListResponseDto,
  ChatSessionResponseDto,
} from '../dto/chat-response.dto';
import { ChatCitation } from '../chat.types';
import { sortChatSessions } from './chat-session-order';
import {
  assertSessionAccess,
  encodeSessionCursor,
  formatMessageResponse,
  formatSessionResponse,
  normalizeSessionPageSize,
  parseSessionCursor,
} from './chat-session.formatters';

export interface ChatSessionListParams {
  search?: string;
  cursor?: string;
  limit?: string | number;
}

/**
 * Owns CRUD over chat sessions and messages plus the title auto-generation
 * side-effect.
 *
 * This service intentionally does not know anything about assistant response
 * generation, telemetry, or documentation. `ChatService` orchestrates those
 * concerns and calls into this service for persistence.
 */
@Injectable()
export class ChatSessionService {
  private readonly logger = new Logger(ChatSessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
  ) {}

  // ---------- session reads ----------

  async createSession(
    userId: string,
    dto: CreateChatSessionDto,
  ): Promise<ChatSessionResponseDto> {
    const session = await this.prisma.chatSession.create({
      data: {
        userId,
        shipId: dto.shipId ?? null,
        title: dto.title || 'New Chat',
      },
    });

    return formatSessionResponse(session);
  }

  async listSessions(
    userId: string,
    role: string,
    params?: ChatSessionListParams,
  ): Promise<ChatSessionListResponseDto> {
    const normalizedSearch = params?.search?.trim();
    const pageSize = normalizeSessionPageSize(params?.limit);
    const cursor = parseSessionCursor(params?.cursor);
    const baseWhere: any = { userId, deletedAt: null };

    if (normalizedSearch) {
      baseWhere.title = { contains: normalizedSearch, mode: 'insensitive' };
    }

    const pinnedWhere = { ...baseWhere, pinnedAt: { not: null } };
    const unpinnedWhere: any = { ...baseWhere, pinnedAt: null };
    if (cursor) {
      const cursorDate = new Date(cursor.updatedAt);
      unpinnedWhere.OR = [
        { updatedAt: { lt: cursorDate } },
        { updatedAt: cursorDate, id: { lt: cursor.id } },
      ];
    }

    const [pinnedSessions, unpinnedSessions] = await Promise.all([
      cursor
        ? Promise.resolve([])
        : this.prisma.chatSession.findMany({
            where: pinnedWhere,
            orderBy: [
              { pinnedAt: 'desc' },
              { updatedAt: 'desc' },
              { id: 'desc' },
            ],
            include: {
              messages: {
                where: { deletedAt: null },
                select: { id: true },
              },
            },
          }),
      this.prisma.chatSession.findMany({
        where: unpinnedWhere,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
        include: {
          messages: {
            where: { deletedAt: null },
            select: { id: true },
          },
        },
      }),
    ]);

    const hasMore = unpinnedSessions.length > pageSize;
    const pagedUnpinnedSessions = unpinnedSessions.slice(0, pageSize);
    const sessions = sortChatSessions([
      ...pinnedSessions,
      ...pagedUnpinnedSessions,
    ]).map((session) => ({
      ...formatSessionResponse(session),
      messageCount: session.messages.length,
    }));
    const lastSession = pagedUnpinnedSessions[pagedUnpinnedSessions.length - 1];

    return {
      sessions,
      nextCursor:
        hasMore && lastSession ? encodeSessionCursor(lastSession) : null,
      hasMore,
    };
  }

  async getSession(
    sessionId: string,
    userId: string,
    role: string,
  ): Promise<ChatSessionResponseDto> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          where: { deletedAt: null },
          include: {
            contextReferences: {
              include: {
                shipManual: { select: { shipId: true, category: true } },
              },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!session) throw new NotFoundException('Chat session not found');

    assertSessionAccess(session, userId, role);

    if (session.deletedAt) {
      throw new NotFoundException('Chat session not found');
    }

    return {
      ...formatSessionResponse(session),
      messages: session.messages.map((message) =>
        formatMessageResponse(message),
      ),
    };
  }

  // ---------- session mutations ----------

  async updateSessionTitle(
    sessionId: string,
    userId: string,
    role: string,
    title?: string,
  ): Promise<ChatSessionResponseDto> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) throw new NotFoundException('Chat session not found');
    assertSessionAccess(session, userId, role);

    const updated = await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { title: title || session.title },
    });

    return formatSessionResponse(updated);
  }

  async setSessionPinned(
    sessionId: string,
    userId: string,
    role: string,
    isPinned: boolean,
  ): Promise<ChatSessionResponseDto> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) throw new NotFoundException('Chat session not found');
    assertSessionAccess(session, userId, role);

    const updated = await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { pinnedAt: isPinned ? new Date() : null },
    });

    return formatSessionResponse(updated);
  }

  async deleteSession(
    sessionId: string,
    userId: string,
    role: string,
  ): Promise<void> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) throw new NotFoundException('Chat session not found');

    assertSessionAccess(session, userId, role);

    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { deletedAt: new Date() },
    });
  }

  // ---------- message mutations ----------

  /**
   * Persist a user message and bump the session's updatedAt.
   *
   * Returns the formatted user message plus the ship metadata that the
   * orchestration layer (ChatService) needs to kick off assistant response
   * generation.
   */
  async persistUserMessage(
    sessionId: string,
    userId: string,
    role: string,
    rawContent: string,
  ): Promise<{
    userMessage: ChatMessageResponseDto;
    shipId: string | null;
    shipName: string | null;
  }> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        ship: { select: { id: true, name: true, lastTelemetry: true } },
      },
    });

    if (!session) throw new NotFoundException('Chat session not found');

    assertSessionAccess(session, userId, role);

    if (session.deletedAt) {
      throw new NotFoundException('Chat session not found');
    }

    if (!rawContent?.trim()) {
      throw new BadRequestException('Message content cannot be empty');
    }

    const userMessage = await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'user',
        content: rawContent.trim(),
      },
      include: {
        contextReferences: {
          include: { shipManual: { select: { shipId: true, category: true } } },
        },
      },
    });

    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });

    return {
      userMessage: formatMessageResponse(userMessage),
      shipId: session.shipId ?? null,
      shipName: session.ship?.name ?? null,
    };
  }

  async addAssistantMessage(
    sessionId: string,
    content: string,
    ragflowContext?: Record<string, unknown> | null,
    contextReferences?: ChatCitation[],
  ): Promise<ChatMessageResponseDto> {
    const message = await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content,
        ragflowContext: ragflowContext
          ? JSON.parse(JSON.stringify(ragflowContext))
          : null,
        contextReferences: contextReferences
          ? {
              create: contextReferences.map((reference) => ({
                shipManualId: reference.shipManualId,
                chunkId: reference.chunkId,
                score: reference.score,
                pageNumber: reference.pageNumber,
                snippet: reference.snippet,
                sourceTitle: reference.sourceTitle,
                sourceUrl: reference.sourceUrl,
              })),
            }
          : undefined,
      },
      include: {
        contextReferences: {
          include: { shipManual: { select: { shipId: true, category: true } } },
        },
      },
    });

    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });

    return formatMessageResponse(message);
  }

  async deleteMessage(
    sessionId: string,
    messageId: string,
    userId: string,
    role: string,
  ): Promise<void> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          where: { id: messageId },
          select: { id: true, sessionId: true },
        },
      },
    });

    if (!session) throw new NotFoundException('Chat session not found');

    assertSessionAccess(session, userId, role);

    if (session.deletedAt) {
      throw new NotFoundException('Chat session not found');
    }

    if (session.messages.length === 0) {
      throw new NotFoundException('Message not found');
    }

    await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { deletedAt: new Date() },
    });
  }

  // ---------- session preparation for regenerate ----------

  /**
   * Validate the regenerate request and soft-delete the prior assistant
   * message. Returns the user message content + ship metadata that the
   * orchestrator needs to retry the response.
   */
  async prepareRegenerate(
    sessionId: string,
    userId: string,
    role: string,
  ): Promise<{
    userQuery: string;
    shipId: string | null;
    shipName: string | null;
  }> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        ship: { select: { id: true, name: true } },
        messages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 2,
        },
      },
    });

    if (!session) throw new NotFoundException('Chat session not found');

    assertSessionAccess(session, userId, role);

    if (session.deletedAt) {
      throw new NotFoundException('Chat session not found');
    }

    if (
      session.messages.length < 2 ||
      session.messages[0].role !== 'assistant' ||
      session.messages[1].role !== 'user'
    ) {
      throw new BadRequestException(
        'Regenerate only applies to the last assistant reply',
      );
    }

    await this.prisma.chatMessage.update({
      where: { id: session.messages[0].id },
      data: { deletedAt: new Date() },
    });

    return {
      userQuery: session.messages[1].content,
      shipId: session.shipId ?? null,
      shipName: session.ship?.name ?? null,
    };
  }

  // ---------- title generation (fire-and-forget side effect) ----------

  /**
   * If the session has exactly one user message and a default title, generate
   * a title via the LLM. Failures are logged and swallowed so callers can
   * fire-and-forget.
   */
  async autoGenerateTitle(
    sessionId: string,
    firstMessage: string,
  ): Promise<void> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          where: { deletedAt: null, role: 'user' },
          select: { id: true },
        },
      },
    });

    if (
      !session ||
      session.messages.length !== 1 ||
      (session.title && session.title !== 'New Chat')
    ) {
      return;
    }

    const title = await this.llmService.generateTitle(firstMessage);
    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { title },
    });
  }
}
