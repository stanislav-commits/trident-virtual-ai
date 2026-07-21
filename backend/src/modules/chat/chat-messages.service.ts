import { formatError } from '../../common/utils/error.utils';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { toChatMessageResponse } from './chat.mapper';
import { ChatSessionsService } from './chat-sessions.service';
import { ChatConversationContextService } from './context/chat-conversation-context.service';
import { ChatContextMemoryService } from './context/chat-context-memory.service';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';
import { ChatMessageRole } from './enums/chat-message-role.enum';
import { ChatMessageEntity } from './entities/chat-message.entity';
import { ChatTurnOrchestratorService } from './orchestration/chat-turn-orchestrator.service';
import { sanitizeContextReferencesForClient } from './orchestration/chat-context-reference-sanitizer.util';
import { ChatProgressBus } from './progress/chat-progress.bus';

@Injectable()
export class ChatMessagesService {
  private readonly logger = new Logger(ChatMessagesService.name);

  constructor(
    @InjectRepository(ChatMessageEntity)
    private readonly chatMessagesRepository: Repository<ChatMessageEntity>,
    private readonly chatSessionsService: ChatSessionsService,
    private readonly chatConversationContextService: ChatConversationContextService,
    private readonly chatContextMemoryService: ChatContextMemoryService,
    private readonly chatTurnOrchestratorService: ChatTurnOrchestratorService,
    private readonly chatProgressBus: ChatProgressBus,
  ) {}

  async list(user: AuthenticatedUser, sessionId: string) {
    const session = await this.chatSessionsService.findAccessibleSessionOrThrow(
      user,
      sessionId,
    );

    const messages = await this.chatMessagesRepository.find({
      where: {
        sessionId: session.id,
        deletedAt: IsNull(),
      },
      order: {
        createdAt: 'ASC',
      },
    });

    return messages.map(toChatMessageResponse);
  }

  async createUserMessage(
    user: AuthenticatedUser,
    sessionId: string,
    input: CreateChatMessageDto,
  ) {
    const session = await this.chatSessionsService.findAccessibleSessionOrThrow(
      user,
      sessionId,
    );
    const normalizedContent = this.normalizeContent(input.content);
    const message = this.chatMessagesRepository.create({
      sessionId: session.id,
      role: ChatMessageRole.USER,
      content: normalizedContent,
      ragflowContext: null,
    });
    const savedMessage = await this.chatMessagesRepository.save(message);

    await this.chatSessionsService.applyUserMessageActivity(session.id);

    void this.generateAssistantReplyInBackground(session.id);

    return toChatMessageResponse(savedMessage);
  }

  async regenerateAssistantMessage(
    user: AuthenticatedUser,
    sessionId: string,
  ) {
    await this.chatSessionsService.findAccessibleSessionOrThrow(user, sessionId);

    const lastAssistantMessage = await this.chatMessagesRepository.findOne({
      where: {
        sessionId,
        role: ChatMessageRole.ASSISTANT,
        deletedAt: IsNull(),
      },
      order: {
        createdAt: 'DESC',
      },
    });

    if (lastAssistantMessage) {
      await this.chatMessagesRepository.softDelete(lastAssistantMessage.id);
      await this.chatContextMemoryService.invalidate(sessionId);
    }

    const savedMessage = await this.generateAssistantReply(sessionId);
    return toChatMessageResponse(savedMessage);
  }

  async remove(
    user: AuthenticatedUser,
    sessionId: string,
    messageId: string,
  ): Promise<void> {
    await this.chatSessionsService.findAccessibleSessionOrThrow(user, sessionId);

    const message = await this.chatMessagesRepository.findOne({
      where: {
        id: messageId,
        sessionId,
        deletedAt: IsNull(),
      },
    });

    if (!message) {
      throw new NotFoundException('Chat message not found');
    }

    await this.chatMessagesRepository.softDelete(message.id);
    await this.chatContextMemoryService.invalidate(sessionId);
    await this.chatSessionsService.touchSession(sessionId);
  }

  private async generateAssistantReplyInBackground(
    sessionId: string,
  ): Promise<void> {
    try {
      await this.generateAssistantReply(sessionId);
    } catch (error) {
      this.logger.error(
        `Failed to generate assistant reply for session ${sessionId}: ${
          formatError(error)
        }`,
      );
      this.chatProgressBus.emit(sessionId, {
        type: 'error',
        text: 'Reply generation failed — try again or rephrase.',
      });
    }
  }

  private async generateAssistantReply(
    sessionId: string,
  ): Promise<ChatMessageEntity> {
    const session = await this.chatSessionsService.findSessionById(sessionId, {
      ship: true,
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }

    const messages = await this.chatMessagesRepository.find({
      where: {
        sessionId,
        deletedAt: IsNull(),
      },
      order: {
        createdAt: 'ASC',
      },
    });

    if (!messages.some((message) => message.role === ChatMessageRole.USER)) {
      throw new BadRequestException(
        'Cannot generate assistant reply without a user message',
      );
    }

    this.chatProgressBus.emit(sessionId, {
      type: 'planning',
      text: 'Analyzing the question…',
    });

    const context = await this.chatConversationContextService.build(
      session,
      messages,
    );

    const response = await this.chatTurnOrchestratorService.respond({
      session,
      messages,
      context,
    });
    const assistantMessage = this.chatMessagesRepository.create({
      sessionId,
      role: ChatMessageRole.ASSISTANT,
      content: response.content,
      ragflowContext: this.sanitizeRagflowContext(response.ragflowContext),
    });
    const savedAssistantMessage =
      await this.chatMessagesRepository.save(assistantMessage);

    this.chatProgressBus.emit(sessionId, {
      type: 'done',
      text: 'Reply ready',
      messageId: savedAssistantMessage.id,
    });

    await this.chatSessionsService.touchSession(sessionId);
    // Title generation is async (a separate LLM call) so it must not delay the
    // reply. When it lands, push a 'title' event so the client updates live
    // instead of only after a page reload.
    void this.chatSessionsService
      .refreshAutoTitleAfterTurn({
        sessionId,
        messages: [...messages, savedAssistantMessage],
        summary: context.summary,
      })
      .then((newTitle) => {
        if (newTitle) {
          this.chatProgressBus.emit(sessionId, {
            type: 'title',
            text: newTitle,
            title: newTitle,
          });
        }
      });

    return savedAssistantMessage;
  }

  private normalizeContent(value?: string): string {
    const normalized = value?.trim();

    if (!normalized) {
      throw new BadRequestException('Message content must not be empty');
    }

    return normalized;
  }

  /**
   * Last-line-of-defense scrub before persisting: drop any metric/telemetry
   * reference from the fields the chat client actually reads for Sources —
   * the top-level `contextReferences` (chat.mapper.ts serves this straight
   * to the UI) and each ask's own `contextReferences` (not surfaced today,
   * but kept consistent in case a future UI reads it directly). This holds
   * regardless of which responder produced the reference, so a tagging gap
   * in any one of them can never leak a metric key/asset code into Sources.
   */
  private sanitizeRagflowContext(
    ragflowContext: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!ragflowContext) {
      return null;
    }

    const sanitized: Record<string, unknown> = { ...ragflowContext };

    if (Array.isArray(sanitized.contextReferences)) {
      sanitized.contextReferences = sanitizeContextReferencesForClient(
        sanitized.contextReferences,
      );
    }

    if (Array.isArray(sanitized.askResults)) {
      sanitized.askResults = sanitized.askResults.map((askResult) => {
        if (
          !askResult ||
          typeof askResult !== 'object' ||
          !Array.isArray((askResult as Record<string, unknown>).contextReferences)
        ) {
          return askResult;
        }

        return {
          ...askResult,
          contextReferences: sanitizeContextReferencesForClient(
            (askResult as Record<string, unknown>).contextReferences as unknown[],
          ),
        };
      });
    }

    return sanitized;
  }
}
