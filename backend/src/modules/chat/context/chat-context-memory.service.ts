import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatLlmService } from '../chat-llm.service';
import { ChatMessageEntity } from '../entities/chat-message.entity';
import { ChatSessionEntity } from '../entities/chat-session.entity';
import {
  CHAT_CONTEXT_MIN_MESSAGES_FOR_SUMMARY,
  CHAT_CONTEXT_RECENT_MESSAGE_WINDOW,
  CHAT_CONTEXT_SUMMARY_MAX_TOKENS,
  CHAT_CONTEXT_SUMMARY_REFRESH_BATCH,
} from './chat-context.constants';
import {
  formatConversationSummary,
  formatMessageTranscript,
} from './chat-context-prompt.utils';
import { ChatSessionMemoryEntity } from './entities/chat-session-memory.entity';

@Injectable()
export class ChatContextMemoryService {
  private readonly logger = new Logger(ChatContextMemoryService.name);

  constructor(
    @InjectRepository(ChatSessionMemoryEntity)
    private readonly chatSessionMemoryRepository: Repository<ChatSessionMemoryEntity>,
    private readonly chatLlmService: ChatLlmService,
  ) {}

  async getSummaryState(
    session: ChatSessionEntity,
    messages: ChatMessageEntity[],
  ): Promise<ChatSessionMemoryEntity> {
    const activeMessages = messages.filter((message) => !message.deletedAt);
    const memory = await this.getOrCreate(session.id);

    if (memory.coveredMessageCount > activeMessages.length) {
      memory.summary = null;
      memory.coveredMessageCount = 0;
      return this.chatSessionMemoryRepository.save(memory);
    }

    const targetCoveredMessageCount =
      this.computeTargetCoveredMessageCount(activeMessages.length);

    if (targetCoveredMessageCount <= memory.coveredMessageCount) {
      return memory;
    }

    if (
      memory.coveredMessageCount > 0 &&
      targetCoveredMessageCount - memory.coveredMessageCount <
        CHAT_CONTEXT_SUMMARY_REFRESH_BATCH
    ) {
      return memory;
    }

    const messagesToSummarize = activeMessages.slice(
      memory.coveredMessageCount,
      targetCoveredMessageCount,
    );

    if (!messagesToSummarize.length) {
      return memory;
    }

    try {
      const updatedSummary = await this.generateUpdatedSummary({
        session,
        existingSummary: memory.summary,
        messagesToSummarize,
      });

      if (!updatedSummary) {
        return memory;
      }

      memory.summary = updatedSummary;
      memory.coveredMessageCount = targetCoveredMessageCount;
      return await this.chatSessionMemoryRepository.save(memory);
    } catch (error) {
      this.logger.warn(
        `Failed to refresh chat context summary for session ${session.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return memory;
    }
  }

  async invalidate(sessionId: string): Promise<void> {
    const memory = await this.chatSessionMemoryRepository.findOne({
      where: { sessionId },
    });

    if (!memory) {
      return;
    }

    memory.summary = null;
    memory.coveredMessageCount = 0;
    await this.chatSessionMemoryRepository.save(memory);
  }

  private async getOrCreate(sessionId: string): Promise<ChatSessionMemoryEntity> {
    const existing = await this.chatSessionMemoryRepository.findOne({
      where: { sessionId },
    });

    if (existing) {
      return existing;
    }

    return this.chatSessionMemoryRepository.save(
      this.chatSessionMemoryRepository.create({
        sessionId,
        summary: null,
        coveredMessageCount: 0,
      }),
    );
  }

  private computeTargetCoveredMessageCount(totalMessages: number): number {
    if (totalMessages < CHAT_CONTEXT_MIN_MESSAGES_FOR_SUMMARY) {
      return 0;
    }

    return Math.max(0, totalMessages - CHAT_CONTEXT_RECENT_MESSAGE_WINDOW);
  }

  private async generateUpdatedSummary(input: {
    session: ChatSessionEntity;
    existingSummary: string | null;
    messagesToSummarize: ChatMessageEntity[];
  }): Promise<string | null> {
    return this.chatLlmService.completeText({
      systemPrompt: [
        'You maintain a rolling conversation memory for the Trident chat backend.',
        'Update the persistent summary using the previous summary and the new conversation chunk.',
        'Preserve durable context only: main topic, entities, user goals, constraints, decisions, factual details, and unresolved follow-ups.',
        'Do not copy every turn verbatim.',
        'Keep the summary compact and structured as plain text using these headings exactly:',
        'TOPIC',
        'USER GOALS',
        'KEY FACTS',
        'OPEN THREADS',
      ].join(' '),
      userPrompt: [
        `Active ship context: ${this.describeShipContext(input.session)}`,
        '',
        'Previous summary:',
        formatConversationSummary(input.existingSummary),
        '',
        'New conversation chunk:',
        formatMessageTranscript(input.messagesToSummarize),
        '',
        'Return only the updated summary.',
      ].join('\n'),
      temperature: 0.1,
      maxTokens: CHAT_CONTEXT_SUMMARY_MAX_TOKENS,
    });
  }

  private describeShipContext(session: ChatSessionEntity): string {
    if (!session.ship) {
      return 'none';
    }

    if (session.ship.organizationName) {
      return `${session.ship.name} / ${session.ship.organizationName}`;
    }

    return session.ship.name;
  }
}
