import { Injectable, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatDocumentationQueryService } from '../../knowledge-base/documentation/chat-documentation-query.service';
import {
  ChatHistoryMessage,
  ChatNormalizedQuery,
} from '../chat.types';
import { buildConversationalReply } from '../conversation/chat-language.utils';
import { ChatQueryNormalizationService } from '../query/chat-query-normalization.service';

export interface ChatTurnContext {
  messageHistory: ChatHistoryMessage[];
  normalizedQuery: ChatNormalizedQuery;
  previousQuestionReply: string | null;
  conversationalReply: string | null;
}

@Injectable()
export class ChatTurnContextService {
  private readonly queryNormalizationService: ChatQueryNormalizationService;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    documentationQueryService?: ChatDocumentationQueryService,
  ) {
    this.queryNormalizationService = new ChatQueryNormalizationService(
      documentationQueryService ?? new ChatDocumentationQueryService(),
    );
  }

  async buildTurnContext(params: {
    sessionId: string;
    userQuery: string;
  }): Promise<ChatTurnContext> {
    const { sessionId, userQuery } = params;
    const messageHistory = await this.loadMessageHistory(sessionId);
    const normalizedQuery = this.queryNormalizationService.normalizeTurn({
      userQuery,
      messageHistory,
    });

    return {
      messageHistory,
      normalizedQuery,
      previousQuestionReply: this.buildPreviousQuestionReply(
        userQuery,
        messageHistory,
      ),
      conversationalReply: buildConversationalReply(userQuery),
    };
  }

  private async loadMessageHistory(
    sessionId: string,
  ): Promise<ChatHistoryMessage[]> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 20,
          include: {
            contextReferences: {
              include: {
                shipManual: { select: { shipId: true, category: true } },
              },
            },
          },
        },
      },
    });

    return [...(session?.messages ?? [])]
      .reverse()
      .map((message) => ({
        role: message.role,
        content: message.content,
        ragflowContext: message.ragflowContext ?? undefined,
        contextReferences: (message.contextReferences || []).map(
          (reference) => ({
            shipManualId: reference.shipManualId ?? undefined,
            chunkId: reference.chunkId ?? undefined,
            score: reference.score ?? undefined,
            pageNumber: reference.pageNumber ?? undefined,
            snippet: reference.snippet ?? undefined,
            sourceTitle: reference.sourceTitle ?? undefined,
            sourceCategory: reference.shipManual?.category ?? undefined,
            sourceUrl: reference.sourceUrl ?? undefined,
          }),
        ),
      }));
  }

  private buildPreviousQuestionReply(
    userQuery: string,
    messageHistory: Array<{ role: string; content: string }>,
  ): string | null {
    if (!this.isPreviousQuestionQuery(userQuery)) {
      return null;
    }

    const normalizedCurrentQuery =
      this.normalizeConversationMemoryText(userQuery);
    const previousUserMessage = [...messageHistory]
      .reverse()
      .filter((message) => message.role === 'user')
      .find(
        (message) =>
          this.normalizeConversationMemoryText(message.content) !==
          normalizedCurrentQuery,
      );

    if (!previousUserMessage?.content?.trim()) {
      return "I don't have a previous user question in this chat yet.";
    }

    return `Your previous question was: "${previousUserMessage.content.trim()}".`;
  }

  private isPreviousQuestionQuery(userQuery: string): boolean {
    return /\b(?:what|which)\s+was\s+(?:the\s+)?(?:previous|last)\s+(?:question|query|thing\s+i\s+asked)\b/i.test(
      userQuery.trim(),
    );
  }

  private normalizeConversationMemoryText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
  }
}
