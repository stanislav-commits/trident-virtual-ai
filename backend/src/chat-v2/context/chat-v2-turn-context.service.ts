import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ChatV2ConversationMessage,
  ChatV2TurnContext,
} from './chat-v2-turn-context.types';

@Injectable()
export class ChatV2TurnContextService {
  constructor(private readonly prisma: PrismaService) {}

  async buildTurnContext(params: {
    sessionId: string;
    userQuery: string;
  }): Promise<ChatV2TurnContext> {
    const { sessionId, userQuery } = params;
    const messageHistory = await this.loadMessageHistory(sessionId);
    const previousMessages = this.excludeCurrentUserTurn(
      messageHistory,
      userQuery,
    );

    return {
      sessionId,
      userQuery,
      messageHistory,
      previousMessages,
      latestAssistantLlmResponseId:
        this.getLatestAssistantLlmResponseId(previousMessages),
      latestUserMessageBeforeCurrent: this.findLatestMessageByRole(
        previousMessages,
        'user',
      ),
      latestAssistantMessageBeforeCurrent: this.findLatestMessageByRole(
        previousMessages,
        'assistant',
      ),
    };
  }

  private async loadMessageHistory(
    sessionId: string,
  ): Promise<ChatV2ConversationMessage[]> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            role: true,
            content: true,
            ragflowContext: true,
          },
        },
      },
    });

    return [...(session?.messages ?? [])].reverse().map((message) => ({
      role: message.role,
      content: message.content,
      ragflowContext: message.ragflowContext ?? undefined,
    }));
  }

  private getLatestAssistantLlmResponseId(
    messageHistory: ChatV2ConversationMessage[],
  ): string | undefined {
    for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
      const message = messageHistory[index];
      if (message.role !== 'assistant') {
        continue;
      }

      if (
        !message.ragflowContext ||
        typeof message.ragflowContext !== 'object'
      ) {
        continue;
      }

      const llmResponseId = (message.ragflowContext as Record<string, unknown>)
        .llmResponseId;
      if (typeof llmResponseId === 'string' && llmResponseId.trim()) {
        return llmResponseId.trim();
      }
    }

    return undefined;
  }

  private excludeCurrentUserTurn(
    messageHistory: ChatV2ConversationMessage[],
    userQuery: string,
  ): ChatV2ConversationMessage[] {
    if (messageHistory.length === 0) {
      return [];
    }

    const latestMessage = messageHistory[messageHistory.length - 1];
    if (
      latestMessage.role === 'user' &&
      latestMessage.content.trim() === userQuery.trim()
    ) {
      return messageHistory.slice(0, -1);
    }

    return [...messageHistory];
  }

  private findLatestMessageByRole(
    messageHistory: ChatV2ConversationMessage[],
    role: ChatV2ConversationMessage['role'],
  ): ChatV2ConversationMessage | undefined {
    for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
      const message = messageHistory[index];
      if (message.role === role && message.content.trim()) {
        return message;
      }
    }

    return undefined;
  }
}
