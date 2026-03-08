import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatContextService } from './chat-context.service';
import { LlmService } from './llm.service';
import { MetricsService } from '../metrics/metrics.service';
import { CreateChatSessionDto } from './dto/create-chat-session.dto';
import { SendMessageDto } from './dto/send-message.dto';
import {
  ChatSessionResponseDto,
  ChatMessageResponseDto,
} from './dto/chat-response.dto';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contextService: ChatContextService,
    private readonly llmService: LlmService,
    private readonly metricsService: MetricsService,
  ) {}

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

    return this.formatSessionResponse(session);
  }

  async listSessions(
    userId: string,
    role: string,
    search?: string,
  ): Promise<ChatSessionResponseDto[]> {
    // Sessions are private per account, regardless of role.
    let where: any = { userId, deletedAt: null };

    if (search) {
      where.title = { contains: search, mode: 'insensitive' };
    }

    const sessions = await this.prisma.chatSession.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
    });

    return sessions.map((s) => ({
      ...this.formatSessionResponse(s),
      messageCount: s.messages.length,
    }));
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
              include: { shipManual: { select: { shipId: true } } },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!session) throw new NotFoundException('Chat session not found');

    this.validateAccess(session, userId, role);

    if (session.deletedAt)
      throw new NotFoundException('Chat session not found');

    return {
      ...this.formatSessionResponse(session),
      messages: session.messages.map((msg) => this.formatMessageResponse(msg)),
    };
  }

  async addMessage(
    sessionId: string,
    userId: string,
    role: string,
    dto: SendMessageDto,
  ): Promise<ChatMessageResponseDto> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        ship: { select: { id: true, name: true, lastTelemetry: true } },
      },
    });

    if (!session) throw new NotFoundException('Chat session not found');

    this.validateAccess(session, userId, role);

    if (session.deletedAt)
      throw new NotFoundException('Chat session not found');

    if (!dto.content?.trim()) {
      throw new BadRequestException('Message content cannot be empty');
    }

    const userMessage = await this.prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'user',
        content: dto.content.trim(),
      },
      include: {
        contextReferences: {
          include: { shipManual: { select: { shipId: true } } },
        },
      },
    });

    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });

    // Auto-generate title from first user message
    this.autoGenerateTitle(sessionId, dto.content).catch((err) =>
      console.error('Failed to auto-generate title:', err),
    );

    this.generateAssistantResponse(
      session.shipId ?? null,
      sessionId,
      dto.content,
      session.ship?.name,
      role,
    ).catch((err) =>
      console.error('Failed to generate assistant response:', err),
    );

    return this.formatMessageResponse(userMessage);
  }

  private async autoGenerateTitle(
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

    // Only generate title on the first user message and if title is still default
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

  private async generateAssistantResponse(
    shipId: string | null,
    sessionId: string,
    userQuery: string,
    shipName?: string,
    role: string = 'user',
  ): Promise<ChatMessageResponseDto> {
    try {
      const session = await this.prisma.chatSession.findUnique({
        where: { id: sessionId },
        include: {
          messages: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
            take: 10,
          },
        },
      });

      // RAG context is best-effort: if retrieval fails, continue with telemetry-only response.
      let citations: Array<{
        shipManualId?: string;
        chunkId?: string;
        score?: number;
        pageNumber?: number;
        snippet?: string;
        sourceTitle?: string;
      }> = [];
      try {
        if (role === 'admin' || !shipId) {
          citations =
            await this.contextService.findContextForAdminQuery(userQuery);
        } else {
          const result = await this.contextService.findContextForQuery(
            shipId,
            userQuery,
          );
          citations = result.citations;
        }

        // If primary retrieval found nothing, retry with an expanded query.
        if (citations.length === 0) {
          const fallbackQuery = this.buildRagFallbackQuery(userQuery);
          if (fallbackQuery !== userQuery) {
            if (role === 'admin' || !shipId) {
              citations =
                await this.contextService.findContextForAdminQuery(
                  fallbackQuery,
                );
            } else {
              const fallbackResult =
                await this.contextService.findContextForQuery(
                  shipId,
                  fallbackQuery,
                );
              citations = fallbackResult.citations;
            }
          }
        }
      } catch (error) {
        this.logger.warn(
          `RAG retrieval skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Fetch live telemetry (best-effort, must not block response generation).
      // User mode: selected ship only. Admin mode: aggregate from all ships that have active metrics.
      let telemetry: Record<string, unknown> = {};
      const telemetryShips: string[] = [];
      try {
        if (shipId) {
          telemetry = await this.metricsService.getShipTelemetry(shipId);
          if (shipName) telemetryShips.push(shipName);
        } else if (role === 'admin') {
          const shipsWithMetrics = await this.prisma.ship.findMany({
            where: { metricsConfig: { some: { isActive: true } } },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
          });

          for (const ship of shipsWithMetrics) {
            const shipTelemetry = await this.metricsService.getShipTelemetry(
              ship.id,
            );
            if (Object.keys(shipTelemetry).length > 0) {
              telemetryShips.push(ship.name);
            }
            Object.entries(shipTelemetry).forEach(([label, value]) => {
              telemetry[`[${ship.name}] ${label}`] = value;
            });
          }
        }
      } catch {
        // telemetry is best-effort; don't block the response
      }

      const response = await this.llmService.generateResponse({
        userQuery,
        citations: citations.map((c) => ({
          snippet: c.snippet || '',
          sourceTitle: c.sourceTitle || 'Unknown',
          pageNumber: c.pageNumber,
        })),
        noDocumentation: citations.length === 0,
        shipName,
        telemetry,
        chatHistory: session?.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      return this.addAssistantMessage(
        sessionId,
        response,
        {
          ...(telemetryShips.length > 0
            ? { telemetryShips: [...new Set(telemetryShips)] }
            : {}),
          ...(citations.length === 0 ? { noDocumentation: true } : {}),
        },
        citations,
      );
    } catch (err) {
      const fallback = `I encountered an issue processing your query: ${err instanceof Error ? err.message : 'Unknown error'}. Please try again or contact support.`;
      return this.addAssistantMessage(sessionId, fallback);
    }
  }

  async addAssistantMessage(
    sessionId: string,
    content: string,
    ragflowContext?: Record<string, unknown> | null,
    contextReferences?: Array<{
      shipManualId?: string;
      chunkId?: string;
      score?: number;
      pageNumber?: number;
      snippet?: string;
      sourceTitle?: string;
      sourceUrl?: string;
    }>,
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
              create: contextReferences,
            }
          : undefined,
      },
      include: {
        contextReferences: {
          include: { shipManual: { select: { shipId: true } } },
        },
      },
    });

    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });

    return this.formatMessageResponse(message);
  }

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
    this.validateAccess(session, userId, role);

    const updated = await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { title: title || session.title },
    });

    return this.formatSessionResponse(updated);
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

    this.validateAccess(session, userId, role);

    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { deletedAt: new Date() },
    });
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

    this.validateAccess(session, userId, role);

    if (session.deletedAt)
      throw new NotFoundException('Chat session not found');

    if (session.messages.length === 0)
      throw new NotFoundException('Message not found');

    await this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { deletedAt: new Date() },
    });
  }

  async regenerateLastResponse(
    sessionId: string,
    userId: string,
    role: string,
  ): Promise<ChatMessageResponseDto> {
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

    this.validateAccess(session, userId, role);

    if (session.deletedAt)
      throw new NotFoundException('Chat session not found');

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

    return this.generateAssistantResponse(
      session.shipId ?? null,
      sessionId,
      session.messages[1].content,
      session.ship?.name,
      role,
    );
  }

  private validateAccess(
    session: { userId: string },
    userId: string,
    role: string,
  ): void {
    // Chat session ownership is strict: only creator can access it.
    if (session.userId !== userId) {
      throw new ForbiddenException('Cannot access this chat session');
    }
  }

  private buildRagFallbackQuery(userQuery: string): string {
    const normalized = userQuery.trim().replace(/\s+/g, ' ');
    if (!normalized) return userQuery;
    return `${normalized}. Include normal range, limits, alarms, troubleshooting and operating procedure.`;
  }

  private formatSessionResponse(session: {
    id: string;
    title: string | null;
    userId: string;
    shipId: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }): ChatSessionResponseDto {
    return {
      id: session.id,
      title: session.title ?? undefined,
      userId: session.userId,
      shipId: session.shipId,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      deletedAt: session.deletedAt?.toISOString() ?? null,
    };
  }

  private formatMessageResponse(message: any): ChatMessageResponseDto {
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
        sourceUrl: ref.sourceUrl,
      })),
      createdAt: message.createdAt.toISOString(),
      deletedAt: message.deletedAt?.toISOString() ?? null,
    };
  }
}
