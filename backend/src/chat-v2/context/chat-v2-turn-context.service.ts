import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ChatV2PendingClarification } from '../clarification/chat-v2-clarification.types';
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
    const sessionContext = await this.loadSessionContext(sessionId);
    const messageHistory = sessionContext.messageHistory;
    const previousMessages = this.excludeCurrentUserTurn(
      messageHistory,
      userQuery,
    );

    return {
      sessionId,
      shipId: sessionContext.shipId,
      shipName: sessionContext.shipName,
      shipOrganizationName: sessionContext.shipOrganizationName,
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
      activeClarification: this.extractActiveClarification(previousMessages),
    };
  }

  private async loadSessionContext(
    sessionId: string,
  ): Promise<{
    shipId?: string;
    shipName?: string;
    shipOrganizationName?: string;
    messageHistory: ChatV2ConversationMessage[];
  }> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        ship: {
          select: {
            id: true,
            name: true,
            organizationName: true,
          },
        },
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

    return {
      shipId: session?.ship?.id ?? undefined,
      shipName: session?.ship?.name ?? undefined,
      shipOrganizationName: session?.ship?.organizationName ?? undefined,
      messageHistory: [...(session?.messages ?? [])].reverse().map(
        (message) => ({
          role: message.role,
          content: message.content,
          ragflowContext: message.ragflowContext ?? undefined,
        }),
      ),
    };
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

  private extractActiveClarification(
    messageHistory: ChatV2ConversationMessage[],
  ): ChatV2PendingClarification | undefined {
    for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
      const message = messageHistory[index];
      if (message.role !== 'assistant') {
        continue;
      }

      if (!message.ragflowContext || typeof message.ragflowContext !== 'object') {
        continue;
      }

      const pendingClarification = (message.ragflowContext as Record<string, unknown>)
        .pendingClarification;
      if (!pendingClarification || typeof pendingClarification !== 'object') {
        continue;
      }

      const parsed = this.parsePendingClarification(
        pendingClarification as Record<string, unknown>,
      );
      if (parsed) {
        return parsed;
      }
    }

    return undefined;
  }

  private parsePendingClarification(
    value: Record<string, unknown>,
  ): ChatV2PendingClarification | undefined {
    if (value.domain !== 'metrics_v2') {
      return undefined;
    }

    if (
      value.kind !== 'ambiguous_metrics' &&
      value.kind !== 'group_not_confident' &&
      value.kind !== 'exact_metric_not_found'
    ) {
      return undefined;
    }

    const language =
      value.language === 'uk' ||
      value.language === 'ru' ||
      value.language === 'it' ||
      value.language === 'en' ||
      value.language === 'unknown'
        ? value.language
        : 'unknown';

    const options = Array.isArray(value.options)
      ? value.options
          .filter(
            (option): option is Record<string, unknown> =>
              Boolean(option) && typeof option === 'object',
          )
          .reduce<ChatV2PendingClarification['options']>((acc, option) => {
            const id =
              typeof option.id === 'string' && option.id.trim()
                ? option.id.trim()
                : '';
            const label =
              typeof option.label === 'string' && option.label.trim()
                ? option.label.trim()
                : '';

            if (!id || !label) {
              return acc;
            }

            acc.push({
              id,
              label,
              ...(typeof option.metricKey === 'string' && option.metricKey.trim()
                ? { metricKey: option.metricKey.trim() }
                : {}),
              ...(typeof option.businessConcept === 'string' &&
              option.businessConcept.trim()
                ? { businessConcept: option.businessConcept.trim() }
                : {}),
              ...(typeof option.measurementKind === 'string' &&
              option.measurementKind.trim()
                ? { measurementKind: option.measurementKind.trim() }
                : {}),
              ...(option.source === 'current' || option.source === 'historical'
                ? { source: option.source }
                : {}),
            });

            return acc;
          }, [])
      : [];

    return {
      id:
        typeof value.id === 'string' && value.id.trim()
          ? value.id.trim()
          : 'pending_clarification',
      domain: 'metrics_v2',
      kind:
        value.kind === 'ambiguous_metrics' ||
        value.kind === 'group_not_confident' ||
        value.kind === 'exact_metric_not_found'
          ? value.kind
          : 'ambiguous_metrics',
      language,
      question:
        typeof value.question === 'string' && value.question.trim()
          ? value.question.trim()
          : '',
      originalUserQuery:
        typeof value.originalUserQuery === 'string' &&
        value.originalUserQuery.trim()
          ? value.originalUserQuery.trim()
          : '',
      createdAtIso:
        typeof value.createdAtIso === 'string' && value.createdAtIso.trim()
          ? value.createdAtIso.trim()
          : new Date().toISOString(),
      ...(typeof value.requestId === 'string' && value.requestId.trim()
        ? { requestId: value.requestId.trim() }
        : {}),
      ...(value.requestPlan && typeof value.requestPlan === 'object'
        ? { requestPlan: value.requestPlan as Record<string, unknown> }
        : {}),
      options,
    };
  }
}
