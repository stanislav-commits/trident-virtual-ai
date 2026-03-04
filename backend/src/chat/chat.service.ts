import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatContextService } from './chat-context.service';
import { LlmService } from './llm.service';
import { CreateChatSessionDto } from './dto/create-chat-session.dto';
import { SendMessageDto } from './dto/send-message.dto';
import {
  ChatSessionResponseDto,
  ChatMessageResponseDto,
} from './dto/chat-response.dto';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contextService: ChatContextService,
    private readonly llmService: LlmService,
  ) { }

  async createSession(
    userId: string,
    dto: CreateChatSessionDto,
  ): Promise<ChatSessionResponseDto> {
    const session = await this.prisma.chatSession.create({
      data: {
        userId,
        shipId: dto.shipId ?? null,
        title: dto.title || `Chat on ${new Date().toLocaleDateString()}`,
      },
    });

    return this.formatSessionResponse(session);
  }

  async listSessions(
    userId: string,
    role: string,
    search?: string,
  ): Promise<ChatSessionResponseDto[]> {
    let where: any =
      role === 'admin' ? { deletedAt: null } : { userId, deletedAt: null };

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
            contextReferences: true,
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
        contextReferences: true,
      },
    });

    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });

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

  private async generateAssistantResponse(
    shipId: string | null,
    sessionId: string,
    userQuery: string,
    shipName?: string,
    role: string = 'user',
  ): Promise<void> {
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

      // Admin: global RAG; user: single ship
      let citations;
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

      const response = await this.llmService.generateResponse({
        userQuery,
        citations: citations.map((c) => ({
          snippet: c.snippet || '',
          sourceTitle: c.sourceTitle || 'Unknown',
          pageNumber: c.pageNumber,
        })),
        shipName,
        chatHistory: session?.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      await this.addAssistantMessage(sessionId, response, undefined, citations);
    } catch (err) {
      const fallback = `I encountered an issue processing your query: ${err instanceof Error ? err.message : 'Unknown error'}. Please try again or contact support.`;
      await this.addAssistantMessage(sessionId, fallback);
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
        contextReferences: true,
      },
    });

    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { updatedAt: new Date() },
    });

    return this.formatMessageResponse(message);
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

  private validateAccess(
    session: { userId: string },
    userId: string,
    role: string,
  ): void {
    if (role !== 'admin' && session.userId !== userId) {
      throw new ForbiddenException('Cannot access this chat session');
    }
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
      contextReferences: (message.contextReferences || []).map((ref: any) => ({
        id: ref.id,
        shipManualId: ref.shipManualId,
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
