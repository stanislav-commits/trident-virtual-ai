import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { AuthUser } from '../auth/auth.service';
import { CreateChatSessionDto } from '../chat-shared/dto/create-chat-session.dto';
import {
  ChatMessageResponseDto,
  ChatSessionListResponseDto,
  ChatSessionResponseDto,
} from '../chat-shared/dto/chat-response.dto';
import { SendMessageDto } from '../chat-shared/dto/send-message.dto';
import { SetChatSessionPinDto } from '../chat-shared/dto/set-chat-session-pin.dto';
import {
  ChatSessionListParams,
  ChatSessionService,
} from '../chat-shared/session/chat-session.service';
import {
  ChatV2AssistantDraft,
  ChatV2AnswerRoute,
} from './chat-v2.types';
import { ChatV2ResponseOrchestratorService } from './orchestration/chat-v2-response-orchestrator.service';

@Injectable()
export class ChatV2Service {
  private readonly logger = new Logger(ChatV2Service.name);

  constructor(
    private readonly chatSessionService: ChatSessionService,
    private readonly responseOrchestrator: ChatV2ResponseOrchestratorService,
  ) {}

  async createSession(
    user: AuthUser,
    dto: CreateChatSessionDto,
  ): Promise<ChatSessionResponseDto> {
    this.assertCanCreateSession(user, dto);
    return this.chatSessionService.createSession(user.id, dto);
  }

  listSessions(
    user: AuthUser,
    params?: ChatSessionListParams,
  ): Promise<ChatSessionListResponseDto> {
    return this.chatSessionService.listSessions(user.id, user.role, params);
  }

  getSession(
    sessionId: string,
    user: AuthUser,
  ): Promise<ChatSessionResponseDto> {
    return this.chatSessionService.getSession(sessionId, user.id, user.role);
  }

  updateSessionTitle(
    sessionId: string,
    user: AuthUser,
    title?: string,
  ): Promise<ChatSessionResponseDto> {
    return this.chatSessionService.updateSessionTitle(
      sessionId,
      user.id,
      user.role,
      title,
    );
  }

  setSessionPinned(
    sessionId: string,
    user: AuthUser,
    dto: SetChatSessionPinDto,
  ): Promise<ChatSessionResponseDto> {
    return this.chatSessionService.setSessionPinned(
      sessionId,
      user.id,
      user.role,
      dto.isPinned,
    );
  }

  deleteSession(sessionId: string, user: AuthUser): Promise<void> {
    return this.chatSessionService.deleteSession(sessionId, user.id, user.role);
  }

  deleteMessage(
    sessionId: string,
    messageId: string,
    user: AuthUser,
  ): Promise<void> {
    return this.chatSessionService.deleteMessage(
      sessionId,
      messageId,
      user.id,
      user.role,
    );
  }

  async addMessage(
    sessionId: string,
    user: AuthUser,
    dto: SendMessageDto,
  ): Promise<ChatMessageResponseDto> {
    const { userMessage } = await this.chatSessionService.persistUserMessage(
      sessionId,
      user.id,
      user.role,
      dto.content,
    );

    this.chatSessionService
      .autoGenerateTitle(sessionId, dto.content)
      .catch((error) =>
        this.logger.error('Failed to auto-generate chat v2 title', error),
      );

    this.generateAssistantResponse(sessionId, dto.content).catch((error) =>
      this.logger.error('Failed to generate chat v2 assistant response', error),
    );

    return userMessage;
  }

  async regenerateLastResponse(
    sessionId: string,
    user: AuthUser,
  ): Promise<ChatMessageResponseDto> {
    const { userQuery } = await this.chatSessionService.prepareRegenerate(
      sessionId,
      user.id,
      user.role,
    );

    return this.generateAssistantResponse(sessionId, userQuery);
  }

  private async generateAssistantResponse(
    sessionId: string,
    userQuery: string,
  ): Promise<ChatMessageResponseDto> {
    try {
      const draft = await this.responseOrchestrator.generate({
        sessionId,
        userQuery,
      });
      return this.addAssistantMessage(sessionId, draft);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown chat v2 error';
      this.logger.error('Chat v2 assistant response failed', error);

      return this.addAssistantMessage(sessionId, {
        content: `Chat v2 encountered an issue processing this message: ${errorMessage}`,
        answerRoute: 'error_fallback',
        classification: {
          kind: 'task_request',
          confidence: 0,
          language: null,
          reason: 'Classification did not complete before the error',
          userTask: userQuery,
        },
        usedLlm: false,
        sourceOfTruth: 'unknown',
        extraContext: {
          error: true,
          errorMessage,
        },
      });
    }
  }

  private addAssistantMessage(
    sessionId: string,
    draft: ChatV2AssistantDraft,
  ): Promise<ChatMessageResponseDto> {
    return this.chatSessionService.addAssistantMessage(
      sessionId,
      draft.content,
      {
        chatVersion: 'v2',
        answerRoute: draft.answerRoute as ChatV2AnswerRoute,
        turnClassification: draft.classification,
        taskRoute: draft.taskRoute ?? null,
        sourceOfTruth: draft.sourceOfTruth,
        usedLlm: draft.usedLlm,
        usedDocumentation: false,
        usedCurrentTelemetry: draft.usedCurrentTelemetry ?? false,
        usedHistoricalTelemetry: draft.usedHistoricalTelemetry ?? false,
        usedChatHistory: draft.usedChatHistory ?? false,
        usedWebSearch: draft.usedWebSearch ?? false,
        usedChatHistorySummary: draft.usedChatHistorySummary ?? false,
        ...(draft.extraContext ?? {}),
      },
      draft.contextReferences ?? [],
    );
  }

  private assertCanCreateSession(
    user: AuthUser,
    dto: CreateChatSessionDto,
  ): void {
    if (user.role === 'admin') {
      return;
    }

    if (!user.shipId) {
      throw new ForbiddenException('User is not assigned to any ship');
    }

    if (!dto.shipId || user.shipId !== dto.shipId) {
      throw new ForbiddenException('Cannot create chat for another ship');
    }
  }
}
