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

    await this.chatSessionsService.applyUserMessageActivity(
      session.id,
      normalizedContent,
    );

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
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
      ragflowContext: response.ragflowContext ?? null,
    });
    const savedAssistantMessage =
      await this.chatMessagesRepository.save(assistantMessage);

    await this.chatSessionsService.touchSession(sessionId);

    return savedAssistantMessage;
  }

  private normalizeContent(value?: string): string {
    const normalized = value?.trim();

    if (!normalized) {
      throw new BadRequestException('Message content must not be empty');
    }

    return normalized;
  }
}
