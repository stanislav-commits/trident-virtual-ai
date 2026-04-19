import { Injectable } from '@nestjs/common';
import { ChatMessageEntity } from '../entities/chat-message.entity';
import { ChatSessionEntity } from '../entities/chat-session.entity';
import { ChatConversationContext } from './chat-conversation-context.types';
import { ChatContextMemoryService } from './chat-context-memory.service';

@Injectable()
export class ChatConversationContextService {
  constructor(
    private readonly chatContextMemoryService: ChatContextMemoryService,
  ) {}

  async build(
    session: ChatSessionEntity,
    messages: ChatMessageEntity[],
  ): Promise<ChatConversationContext> {
    const activeMessages = messages.filter((message) => !message.deletedAt);
    const memory = await this.chatContextMemoryService.getSummaryState(
      session,
      activeMessages,
    );
    const recentMessages = activeMessages.slice(memory.coveredMessageCount);

    return {
      session,
      allMessages: activeMessages,
      recentMessages,
      latestUserMessage:
        [...activeMessages]
          .reverse()
          .find((message) => message.role === 'user') ?? null,
      summary: memory.summary,
      coveredMessageCount: memory.coveredMessageCount,
    };
  }
}
