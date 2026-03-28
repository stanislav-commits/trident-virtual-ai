import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService } from './llm.service';
import { MetricsService } from '../metrics/metrics.service';
import { CreateChatSessionDto } from './dto/create-chat-session.dto';
import { SendMessageDto } from './dto/send-message.dto';
import {
  ChatSessionResponseDto,
  ChatMessageResponseDto,
} from './dto/chat-response.dto';
import { ChatDocumentationService } from './chat-documentation.service';
import { ChatCitation } from './chat.types';
import { sortChatSessions } from './chat-session-order';
import {
  ChatQueryPlan,
  ChatQueryPlannerService,
} from './chat-query-planner.service';

interface TelemetryClarificationAction {
  label: string;
  message: string;
  kind?: 'suggestion' | 'all';
}

interface TelemetryClarification {
  question: string;
  pendingQuery: string;
  actions: TelemetryClarificationAction[];
}

type TelemetryMatchMode =
  | 'none'
  | 'sample'
  | 'exact'
  | 'direct'
  | 'related';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly queryPlanner = new ChatQueryPlannerService();

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly metricsService: MetricsService,
    private readonly documentationService: ChatDocumentationService,
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

    return sortChatSessions(sessions).map((session) => ({
      ...this.formatSessionResponse(session),
      messageCount: session.messages.length,
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

    if (session.deletedAt) {
      throw new NotFoundException('Chat session not found');
    }

    return {
      ...this.formatSessionResponse(session),
      messages: session.messages.map((message) =>
        this.formatMessageResponse(message),
      ),
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

    if (session.deletedAt) {
      throw new NotFoundException('Chat session not found');
    }

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

    this.autoGenerateTitle(sessionId, dto.content).catch((error) =>
      this.logger.error('Failed to auto-generate title', error),
    );

    this.generateAssistantResponse(
      session.shipId ?? null,
      sessionId,
      dto.content,
      session.ship?.name,
      role,
    ).catch((error) =>
      this.logger.error('Failed to generate assistant response', error),
    );

    return this.formatMessageResponse(userMessage);
  }

  async addAssistantMessage(
    sessionId: string,
    content: string,
    ragflowContext?: Record<string, unknown> | null,
    contextReferences?: ChatCitation[],
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
              create: contextReferences.map((reference) => ({
                shipManualId: reference.shipManualId,
                chunkId: reference.chunkId,
                score: reference.score,
                pageNumber: reference.pageNumber,
                snippet: reference.snippet,
                sourceTitle: reference.sourceTitle,
                sourceUrl: reference.sourceUrl,
              })),
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

  async setSessionPinned(
    sessionId: string,
    userId: string,
    role: string,
    isPinned: boolean,
  ): Promise<ChatSessionResponseDto> {
    const session = await this.prisma.chatSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) throw new NotFoundException('Chat session not found');
    this.validateAccess(session, userId, role);

    const updated = await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { pinnedAt: isPinned ? new Date() : null },
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

    if (session.deletedAt) {
      throw new NotFoundException('Chat session not found');
    }

    if (session.messages.length === 0) {
      throw new NotFoundException('Message not found');
    }

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

    if (session.deletedAt) {
      throw new NotFoundException('Chat session not found');
    }

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

      const documentationContext =
        await this.documentationService.prepareDocumentationContext({
          shipId,
          role,
          userQuery,
          messageHistory: session?.messages.map((message) => ({
            role: message.role,
            content: message.content,
            ragflowContext: message.ragflowContext ?? undefined,
          })),
        });

      const {
        citations,
        previousUserQuery,
        retrievalQuery,
        resolvedSubjectQuery: exactResolvedSubjectQuery,
        answerQuery,
      } =
        documentationContext;
      const resolvedSubjectQuery =
        exactResolvedSubjectQuery ??
        (retrievalQuery !== userQuery ? retrievalQuery : undefined);
      const effectiveUserQuery = answerQuery ?? userQuery;
      this.logger.debug(
        `Chat query context session=${sessionId} ship=${shipId ?? 'none'} userQuery="${this.truncateForLog(
          userQuery,
        )}" effectiveUserQuery="${this.truncateForLog(
          effectiveUserQuery,
        )}" resolvedSubjectQuery="${this.truncateForLog(
          resolvedSubjectQuery ?? '',
        )}"`,
      );
      const queryPlan = this.queryPlanner.planQuery(
        effectiveUserQuery,
        resolvedSubjectQuery,
      );

      if (
        documentationContext.needsClarification &&
        documentationContext.clarificationQuestion
      ) {
        return this.addAssistantMessage(
          sessionId,
          documentationContext.clarificationQuestion,
          {
            awaitingClarification: true,
            pendingClarificationQuery:
              documentationContext.pendingClarificationQuery ?? userQuery.trim(),
            clarificationReason:
              documentationContext.clarificationReason ?? 'underspecified_query',
            ...(documentationContext.clarificationActions &&
            documentationContext.clarificationActions.length > 0
              ? {
                  clarificationActions:
                    documentationContext.clarificationActions,
                }
              : {}),
          },
          [],
        );
      }

      const historicalTelemetryMatch =
        await this.resolveHistoricalTelemetryForContext({
          shipId,
          role,
          sessionId,
          userQuery,
          effectiveUserQuery,
          resolvedSubjectQuery,
        });

      if (historicalTelemetryMatch) {
        const { resolution: historicalTelemetryResolution } =
          historicalTelemetryMatch;

        if (
          historicalTelemetryResolution.kind === 'clarification' &&
          historicalTelemetryResolution.clarificationQuestion
        ) {
          return this.addAssistantMessage(
            sessionId,
            historicalTelemetryResolution.clarificationQuestion,
            {
              awaitingClarification: true,
              pendingClarificationQuery:
                historicalTelemetryResolution.pendingQuery ?? userQuery.trim(),
              clarificationReason: 'historical_telemetry_query',
              ...(historicalTelemetryResolution.clarificationActions?.length
                ? {
                    clarificationActions:
                      historicalTelemetryResolution.clarificationActions,
                  }
                : {}),
              ...(historicalTelemetryMatch.shipName
                ? { telemetryShips: [historicalTelemetryMatch.shipName] }
                : {}),
              ...(resolvedSubjectQuery
                ? { resolvedSubjectQuery }
                : retrievalQuery
                  ? { resolvedSubjectQuery: retrievalQuery }
                  : {}),
            },
            [],
          );
        }

        if (
          historicalTelemetryResolution.kind === 'answer' &&
          historicalTelemetryResolution.content
        ) {
          return this.addAssistantMessage(
            sessionId,
            historicalTelemetryResolution.content,
            {
              historicalTelemetry: true,
              ...(historicalTelemetryMatch.shipName
                ? { telemetryShips: [historicalTelemetryMatch.shipName] }
                : {}),
              resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            },
            [],
          );
        }
      }

      let telemetry: Record<string, unknown> = {};
      let telemetryPrefiltered = false;
      let telemetryMatchMode: TelemetryMatchMode = 'none';
      let telemetryClarification: TelemetryClarification | null = null;
      const telemetryShips: string[] = [];
      const shouldLookupCurrentTelemetry = this.shouldLookupCurrentTelemetry(
        queryPlan,
        effectiveUserQuery,
      );

      try {
        if (shouldLookupCurrentTelemetry && shipId) {
          const telemetryContext =
            await this.metricsService.getShipTelemetryContextForQuery(
              shipId,
              effectiveUserQuery,
              resolvedSubjectQuery,
            );
          telemetry = telemetryContext.telemetry;
          telemetryPrefiltered = telemetryContext.prefiltered;
          telemetryMatchMode = telemetryContext.matchMode;
          telemetryClarification = telemetryContext.clarification;
          this.logger.debug(
            `Telemetry context for ship ${shipId}: matchMode=${telemetryMatchMode}, prefiltered=${telemetryPrefiltered}, matchedMetrics=${telemetryContext.matchedMetrics}, clarificationActions=${telemetryClarification?.actions.length ?? 0}`,
          );
          if (shipName) telemetryShips.push(shipName);
        } else if (shouldLookupCurrentTelemetry && role === 'admin') {
          const shipsWithMetrics = await this.prisma.ship.findMany({
            where: { metricsConfig: { some: { isActive: true } } },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
          });

          for (const ship of shipsWithMetrics) {
            const telemetryContext =
              await this.metricsService.getShipTelemetryContextForQuery(
                ship.id,
                effectiveUserQuery,
                resolvedSubjectQuery,
              );
            const shipTelemetry = telemetryContext.telemetry;
            if (Object.keys(shipTelemetry).length > 0) {
              telemetryShips.push(ship.name);
              telemetryPrefiltered =
                telemetryPrefiltered || telemetryContext.prefiltered;
              if (telemetryMatchMode === 'none') {
                telemetryMatchMode = telemetryContext.matchMode;
              }
            }
            Object.entries(shipTelemetry).forEach(([label, value]) => {
              telemetry[`[${ship.name}] ${label}`] = value;
            });

            if (telemetryContext.clarification?.actions.length) {
              telemetryClarification =
                this.mergeTelemetryClarificationForAdminShip(
                  telemetryClarification,
                  ship.name,
                  telemetryContext.clarification,
                );
            }
          }
        }
      } catch (error) {
        this.logger.warn(
          `Telemetry lookup skipped for query="${effectiveUserQuery}": ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (
        telemetryClarification &&
        telemetryClarification.actions.length > 0 &&
        this.shouldReturnTelemetryClarification(queryPlan, effectiveUserQuery)
      ) {
        this.logger.debug(
          `Returning telemetry clarification for query="${effectiveUserQuery}" with ${telemetryClarification.actions.length} actions`,
        );
        return this.addAssistantMessage(
          sessionId,
          telemetryClarification.question,
          {
            awaitingClarification: true,
            pendingClarificationQuery: telemetryClarification.pendingQuery,
            clarificationReason: 'related_telemetry_options',
            clarificationActions: telemetryClarification.actions,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
            ...(resolvedSubjectQuery
              ? { resolvedSubjectQuery }
              : retrievalQuery
                ? { resolvedSubjectQuery: retrievalQuery }
                : {}),
          },
          [],
        );
      }

      const documentationIntentPattern =
        /\b(based\s+on|recommended|recommendation|action|next\s+step|what\s+should\s+i\s+do|what\s+do\s+i\s+do|procedure|steps?|how\s+to|how\s+do\s+i|manual|documentation|according\s+to\s+(?:the\s+)?(?:manual|documentation|docs?|handbook|guide|procedure|spec(?:ification)?)|normal|range|limit|limits|specified|operating)\b/i;
      const telemetryOnlyQuery = this.isTelemetryOnlyQuery(
        queryPlan,
        effectiveUserQuery,
        telemetryMatchMode,
        documentationIntentPattern,
      );

      const citationsForAnswer = telemetryOnlyQuery ? [] : citations;
      const llmTelemetryContext = this.selectTelemetryContextForLlm(
        queryPlan,
        effectiveUserQuery,
        telemetry,
        telemetryPrefiltered,
        telemetryMatchMode,
      );

      const deterministicForecastAnswer =
        await this.buildDeterministicAnalyticsForecastAnswer({
          shipId,
          role,
          sessionId,
          queryPlan,
          userQuery: effectiveUserQuery,
          telemetry,
        });
      if (deterministicForecastAnswer) {
        return this.addAssistantMessage(
          sessionId,
          deterministicForecastAnswer,
          {
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
            noDocumentation: true,
          },
          [],
        );
      }

      const deterministicCertificateAnswer =
        this.buildDeterministicCertificateStatusAnswer(
          effectiveUserQuery,
          queryPlan.primaryIntent,
          citationsForAnswer,
        );
      if (deterministicCertificateAnswer) {
        return this.addAssistantMessage(
          sessionId,
          deterministicCertificateAnswer.content,
          {
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
          },
          deterministicCertificateAnswer.citations,
        );
      }

      const deterministicDocumentationAnswer =
        this.buildDeterministicDocumentationAnswer(
          effectiveUserQuery,
          queryPlan.primaryIntent,
          citationsForAnswer,
        );
      if (deterministicDocumentationAnswer) {
        return this.addAssistantMessage(
          sessionId,
          deterministicDocumentationAnswer,
          {
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
          },
          citationsForAnswer,
        );
      }

      const deterministicTelemetryUnavailableAnswer =
        this.buildDeterministicTelemetryUnavailableAnswer(
          effectiveUserQuery,
          queryPlan.primaryIntent,
          telemetryPrefiltered,
          telemetryMatchMode,
          citationsForAnswer,
        );
      if (deterministicTelemetryUnavailableAnswer) {
        return this.addAssistantMessage(
          sessionId,
          deterministicTelemetryUnavailableAnswer.content,
          {
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
          },
          deterministicTelemetryUnavailableAnswer.citations,
        );
      }

      const deterministicTelemetryAnswer = this.buildDeterministicTelemetryAnswer(
        queryPlan,
        effectiveUserQuery,
        telemetry,
        telemetryPrefiltered,
        telemetryMatchMode,
      );
      if (deterministicTelemetryAnswer) {
        return this.addAssistantMessage(
          sessionId,
          deterministicTelemetryAnswer,
          {
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
            ...(citationsForAnswer.length === 0 && !telemetryOnlyQuery
              ? { noDocumentation: true }
              : {}),
          },
          citationsForAnswer,
        );
      }

      const response = await this.llmService.generateResponse({
        userQuery: effectiveUserQuery,
        previousUserQuery:
          answerQuery
            ? undefined
            : retrievalQuery !== userQuery
              ? previousUserQuery
              : undefined,
        resolvedSubjectQuery,
        compareBySource: documentationContext.compareBySource,
        sourceComparisonTitles: documentationContext.sourceComparisonTitles,
        citations: citationsForAnswer.map((citation) => ({
          snippet: citation.snippet || '',
          sourceTitle: citation.sourceTitle || 'Unknown',
          sourceCategory: citation.sourceCategory,
          pageNumber: citation.pageNumber,
        })),
        noDocumentation: citationsForAnswer.length === 0,
        shipName,
        telemetry: llmTelemetryContext.telemetry,
        telemetryPrefiltered: llmTelemetryContext.telemetryPrefiltered,
        telemetryMatchMode: llmTelemetryContext.telemetryMatchMode,
        chatHistory: session?.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      });

      return this.addAssistantMessage(
        sessionId,
        response,
        {
          resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
          ...(telemetryShips.length > 0
            ? { telemetryShips: [...new Set(telemetryShips)] }
            : {}),
          ...(citationsForAnswer.length === 0 && !telemetryOnlyQuery
            ? { noDocumentation: true }
            : {}),
        },
        citationsForAnswer,
      );
    } catch (error) {
      const fallback = `I encountered an issue processing your query: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again or contact support.`;
      return this.addAssistantMessage(sessionId, fallback);
    }
  }

  private truncateForLog(value: string, maxLength = 180): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength - 3)}...`;
  }

  private async resolveHistoricalTelemetryForContext(params: {
    shipId: string | null;
    role: string;
    sessionId: string;
    userQuery: string;
    effectiveUserQuery: string;
    resolvedSubjectQuery?: string;
  }): Promise<{
    resolution: Awaited<
      ReturnType<MetricsService['resolveHistoricalTelemetryQuery']>
    >;
    shipId?: string;
    shipName?: string;
  } | null> {
    const {
      shipId,
      role,
      sessionId,
      userQuery,
      effectiveUserQuery,
      resolvedSubjectQuery,
    } = params;

    if (shipId) {
      return {
        resolution: await this.tryResolveHistoricalTelemetryForShip({
          shipId,
          sessionId,
          userQuery,
          effectiveUserQuery,
          resolvedSubjectQuery,
        }),
        shipId,
      };
    }

    if (role !== 'admin') {
      return null;
    }

    const shipsWithMetrics = await this.prisma.ship.findMany({
      where: { metricsConfig: { some: { isActive: true } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    if (shipsWithMetrics.length === 0) {
      return null;
    }

    const matches: Array<{
      shipId: string;
      shipName: string;
      resolution: Awaited<
        ReturnType<MetricsService['resolveHistoricalTelemetryQuery']>
      >;
    }> = [];

    for (const candidateShip of shipsWithMetrics) {
      const resolution = await this.tryResolveHistoricalTelemetryForShip({
        shipId: candidateShip.id,
        sessionId,
        userQuery,
        effectiveUserQuery,
        resolvedSubjectQuery,
      });
      if (resolution.kind === 'none') {
        continue;
      }

      matches.push({
        shipId: candidateShip.id,
        shipName: candidateShip.name,
        resolution,
      });
    }

    this.logger.debug(
      `Historical telemetry admin-global session=${sessionId} candidateShips=${shipsWithMetrics.length} matchedShips=${matches.length}`,
    );

    if (matches.length === 0) {
      return null;
    }

    if (matches.length === 1) {
      return matches[0];
    }

    return {
      resolution: {
        kind: 'clarification',
        clarificationQuestion:
          'Which ship do you want this historical telemetry for?',
        pendingQuery: userQuery.trim(),
        clarificationActions: matches.slice(0, 4).map((match) => ({
          label: match.shipName,
          message: match.shipName,
          kind: 'suggestion',
        })),
      },
    };
  }

  private async tryResolveHistoricalTelemetryForShip(params: {
    shipId: string;
    sessionId: string;
    userQuery: string;
    effectiveUserQuery: string;
    resolvedSubjectQuery?: string;
  }): Promise<
    Awaited<ReturnType<MetricsService['resolveHistoricalTelemetryQuery']>>
  > {
    const {
      shipId,
      sessionId,
      userQuery,
      effectiveUserQuery,
      resolvedSubjectQuery,
    } = params;
    const historicalResolutionAttempts = [
      { source: 'user', query: userQuery },
      ...(effectiveUserQuery !== userQuery
        ? [{ source: 'effective', query: effectiveUserQuery }]
        : []),
    ];
    let historicalTelemetryResolution = { kind: 'none' } as Awaited<
      ReturnType<MetricsService['resolveHistoricalTelemetryQuery']>
    >;

    for (const attempt of historicalResolutionAttempts) {
      this.logger.debug(
        `Historical telemetry attempt session=${sessionId} ship=${shipId} source=${attempt.source} query="${this.truncateForLog(
          attempt.query,
        )}" resolvedSubjectQuery="${this.truncateForLog(
          resolvedSubjectQuery ?? '',
        )}"`,
      );
      const candidateResolution =
        await this.metricsService.resolveHistoricalTelemetryQuery(
          shipId,
          attempt.query,
          resolvedSubjectQuery,
        );
      this.logger.debug(
        `Historical telemetry result session=${sessionId} ship=${shipId} source=${attempt.source} kind=${candidateResolution.kind} clarification="${this.truncateForLog(
          candidateResolution.clarificationQuestion ?? '',
        )}" content="${this.truncateForLog(
          candidateResolution.content ?? '',
        )}"`,
      );
      if (candidateResolution.kind !== 'none') {
        historicalTelemetryResolution = candidateResolution;
        break;
      }
    }

    return historicalTelemetryResolution;
  }

  private validateAccess(
    session: { userId: string },
    userId: string,
    role: string,
  ): void {
    if (session.userId !== userId) {
      throw new ForbiddenException('Cannot access this chat session');
    }
  }

  private formatSessionResponse(session: {
    id: string;
    title: string | null;
    userId: string;
    shipId: string | null;
    pinnedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }): ChatSessionResponseDto {
    return {
      id: session.id,
      title: session.title ?? undefined,
      userId: session.userId,
      shipId: session.shipId,
      pinnedAt: session.pinnedAt?.toISOString() ?? null,
      isPinned: !!session.pinnedAt,
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

  private mergeTelemetryClarificationForAdminShip(
    existing: TelemetryClarification | null,
    shipName: string,
    clarification: TelemetryClarification,
  ): TelemetryClarification {
    const prefixedActions = clarification.actions
      .filter((action) => action.kind !== 'all')
      .map((action) => ({
        label: `${shipName}: ${action.label}`,
        message: `For ${shipName}, ${action.message}`,
        kind: action.kind,
      }));

    if (!existing) {
      return {
        question: clarification.question,
        pendingQuery: clarification.pendingQuery,
        actions: prefixedActions,
      };
    }

    if (prefixedActions.length === 0) {
      return existing;
    }

    const mergedActions: TelemetryClarificationAction[] = [];
    const seen = new Set<string>();
    const candidates = [
      ...existing.actions,
      ...prefixedActions,
    ];

    for (const action of candidates) {
      const normalizedLabel = action.label.trim().toLowerCase();
      if (!normalizedLabel || seen.has(normalizedLabel)) {
        continue;
      }

      seen.add(normalizedLabel);
      mergedActions.push(action);

      if (mergedActions.length >= 4) {
        break;
      }
    }

    return {
      question: existing.question || clarification.question,
      pendingQuery: existing.pendingQuery || clarification.pendingQuery,
      actions: mergedActions.length > 0 ? mergedActions : prefixedActions,
    };
  }

  private buildDeterministicTelemetryAnswer(
    queryPlan: ChatQueryPlan,
    userQuery: string,
    telemetry: Record<string, unknown>,
    telemetryPrefiltered: boolean,
    telemetryMatchMode: TelemetryMatchMode,
  ): string | null {
    if (!this.shouldUseDeterministicTelemetryAnswer(queryPlan, userQuery)) {
      return null;
    }

    if (!telemetryPrefiltered) {
      return null;
    }

    if (telemetryMatchMode !== 'exact' && telemetryMatchMode !== 'direct') {
      return null;
    }

    const aggregateAnswer = this.buildDeterministicAggregateTelemetryAnswer(
      userQuery,
      telemetry,
    );
    if (aggregateAnswer) {
      return aggregateAnswer;
    }

    if (!this.shouldUseDeterministicTelemetryReadAnswer(userQuery)) {
      return null;
    }

    return this.buildDeterministicTelemetryReadAnswer(telemetry);
  }

  private buildDeterministicDocumentationAnswer(
    userQuery: string,
    primaryIntent: string,
    citations: ChatCitation[],
  ): string | null {
    if (citations.length === 0) {
      return null;
    }

    if (primaryIntent === 'manual_specification') {
      return this.buildDeterministicManualSpecificationAnswer(
        userQuery,
        citations,
      );
    }

    return null;
  }

  private buildDeterministicCertificateStatusAnswer(
    userQuery: string,
    primaryIntent: string,
    citations: ChatCitation[],
  ): { content: string; citations: ChatCitation[] } | null {
    if (primaryIntent !== 'certificate_status' || citations.length === 0) {
      return null;
    }

    if (!this.isBroadCertificateSoonQuery(userQuery)) {
      return null;
    }

    const certificateEntries = citations
      .filter(
        (citation) =>
          citation.sourceCategory?.trim().toUpperCase() === 'CERTIFICATES',
      )
      .map((citation) => {
        const expiry = this.extractExplicitCertificateExpiry(citation.snippet);
        if (!expiry) {
          return null;
        }

        return {
          citation,
          timestamp: expiry.timestamp,
          displayDate: expiry.displayDate,
          sourceLabel: citation.sourceTitle ?? 'the cited certificate',
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          citation: ChatCitation;
          timestamp: number;
          displayDate: string;
          sourceLabel: string;
        } => entry !== null,
      )
      .sort((left, right) => left.timestamp - right.timestamp);

    if (certificateEntries.length === 0) {
      const certificateCitations = citations.filter(
        (citation) =>
          citation.sourceCategory?.trim().toUpperCase() === 'CERTIFICATES',
      );
      const fallbackCitations =
        certificateCitations.length > 0
          ? certificateCitations.slice(0, 3)
          : citations.slice(0, 3);

      return {
        content:
          'I could not confirm any currently valid certificates that are due to expire within the next 180 days from the provided certificate documents because the retrieved certificate snippets do not include clear expiry dates.',
        citations: fallbackCitations,
      };
    }

    const now = Date.now();
    const soonHorizonMs = 180 * 24 * 60 * 60 * 1000;
    const upcomingSoon = certificateEntries.filter(
      (entry) =>
        entry.timestamp >= now && entry.timestamp <= now + soonHorizonMs,
    );

    if (upcomingSoon.length > 0) {
      const selected = upcomingSoon.slice(0, 5);
      if (selected.length === 1) {
        const [entry] = selected;
        return {
          content: `The next certificate due to expire within the next 180 days is ${entry.sourceLabel}, which expires on ${entry.displayDate} [Certificate: ${entry.sourceLabel}].`,
          citations: [entry.citation],
        };
      }

      return {
        content: [
          'The following certificates are due to expire within the next 180 days:',
          '',
          ...selected.map(
            (entry) =>
              `- ${entry.sourceLabel}: ${entry.displayDate} [Certificate: ${entry.sourceLabel}]`,
          ),
        ].join('\n'),
        citations: selected.map((entry) => entry.citation),
      };
    }

    const laterUpcoming = certificateEntries.filter(
      (entry) => entry.timestamp >= now + soonHorizonMs,
    );
    if (laterUpcoming.length > 0) {
      const [entry] = laterUpcoming;
      return {
        content: `I could not confirm any currently valid certificates that are due to expire within the next 180 days from the provided certificate documents. The earliest later expiry I found is ${entry.sourceLabel} on ${entry.displayDate} [Certificate: ${entry.sourceLabel}].`,
        citations: [entry.citation],
      };
    }

    const expiredEntries = certificateEntries
      .filter((entry) => entry.timestamp < now)
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, 3);
    if (expiredEntries.length > 0) {
      return {
        content:
          'I could not confirm any currently valid certificates that are due to expire within the next 180 days from the provided certificate documents. The certificate snippets I found with explicit expiry dates are already expired.',
        citations: expiredEntries.map((entry) => entry.citation),
      };
    }

    return null;
  }

  private async buildDeterministicAnalyticsForecastAnswer(params: {
    shipId: string | null;
    role: string;
    sessionId: string;
    queryPlan: ChatQueryPlan;
    userQuery: string;
    telemetry: Record<string, unknown>;
  }): Promise<string | null> {
    const { shipId, role, sessionId, queryPlan, userQuery, telemetry } = params;

    if (queryPlan.primaryIntent !== 'analytics_forecast') {
      return null;
    }

    if (!this.isFuelForecastQuery(userQuery)) {
      return null;
    }

    const historyBasisQuery = this.buildFuelForecastHistoricalBasisQuery(userQuery);
    const historicalMatch = await this.resolveHistoricalTelemetryForContext({
      shipId,
      role,
      sessionId,
      userQuery: historyBasisQuery,
      effectiveUserQuery: historyBasisQuery,
      resolvedSubjectQuery: historyBasisQuery,
    });

    if (
      !historicalMatch ||
      historicalMatch.resolution.kind !== 'answer' ||
      !historicalMatch.resolution.content
    ) {
      return null;
    }

    const projectedFuel = this.extractHistoricalFuelLiters(
      historicalMatch.resolution.content,
    );
    if (projectedFuel === null) {
      return null;
    }

    const onboardFuel = this.sumCurrentFuelTankTelemetry(telemetry);
    const basisLabel = this.describeFuelForecastBasis(userQuery, historyBasisQuery);
    const lines = [
      `Based on historical telemetry from ${basisLabel}, projected fuel consumption for the next month is approximately ${this.formatAggregateNumber(projectedFuel)} liters [Telemetry History].`,
    ];

    if (onboardFuel !== null) {
      lines.push(
        `Current onboard fuel across the matched tank readings is ${this.formatAggregateNumber(onboardFuel)} liters [Telemetry].`,
      );
    }

    lines.push(
      'This estimate assumes a similar operational profile to the selected historical period.',
    );

    return lines.join('\n\n');
  }

  private isBroadCertificateSoonQuery(query: string): boolean {
    const normalized = query.toLowerCase();
    return (
      /\bcertificates\b/.test(normalized) &&
      /\b(expire|expiry|expiring|valid\s+until)\b/.test(normalized) &&
      /\b(soon|upcoming|next)\b/.test(normalized)
    );
  }

  private extractExplicitCertificateExpiry(
    snippet?: string,
  ): { timestamp: number; displayDate: string } | null {
    if (!snippet) {
      return null;
    }

    const plainText = snippet
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const patterns = [
      /\b(?:valid\s+until|expiry(?:\s+date)?|expiration(?:\s+date)?|expiring|expires?\s+on|expire\s+on|will\s+expire\s+on|scadenza(?:\s*\/\s*expiring)?|expiring:)\b[^0-9a-z]{0,20}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}\s+[a-z]{3,9}\s+\d{2,4})\b/i,
    ];

    for (const pattern of patterns) {
      const match = plainText.match(pattern);
      if (!match?.[1]) {
        continue;
      }

      const parsedDate = this.parseExplicitCertificateDateToken(match[1]);
      if (!parsedDate) {
        continue;
      }

      return {
        timestamp: parsedDate,
        displayDate: this.formatExplicitCertificateDate(parsedDate),
      };
    }

    return null;
  }

  private parseExplicitCertificateDateToken(token: string): number | null {
    const normalized = token.replace(/\s+/g, ' ').trim();
    const monthNames = new Map<string, number>([
      ['jan', 0],
      ['january', 0],
      ['feb', 1],
      ['february', 1],
      ['mar', 2],
      ['march', 2],
      ['apr', 3],
      ['april', 3],
      ['may', 4],
      ['jun', 5],
      ['june', 5],
      ['jul', 6],
      ['july', 6],
      ['aug', 7],
      ['august', 7],
      ['sep', 8],
      ['sept', 8],
      ['september', 8],
      ['oct', 9],
      ['october', 9],
      ['nov', 10],
      ['november', 10],
      ['dec', 11],
      ['december', 11],
    ]);

    const numericMatch = normalized.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
    if (numericMatch) {
      const day = Number.parseInt(numericMatch[1], 10);
      const month = Number.parseInt(numericMatch[2], 10) - 1;
      let year = Number.parseInt(numericMatch[3], 10);
      if (year < 100) {
        year += year >= 70 ? 1900 : 2000;
      }
      const timestamp = Date.UTC(year, month, day);
      return Number.isNaN(timestamp) ? null : timestamp;
    }

    const monthNameMatch = normalized.match(
      /^(\d{1,2})\s+([a-z]{3,9})\s+(\d{2,4})$/i,
    );
    if (monthNameMatch) {
      const day = Number.parseInt(monthNameMatch[1], 10);
      const month = monthNames.get(monthNameMatch[2].toLowerCase());
      if (month === undefined) {
        return null;
      }
      let year = Number.parseInt(monthNameMatch[3], 10);
      if (year < 100) {
        year += year >= 70 ? 1900 : 2000;
      }
      const timestamp = Date.UTC(year, month, day);
      return Number.isNaN(timestamp) ? null : timestamp;
    }

    return null;
  }

  private formatExplicitCertificateDate(timestamp: number): string {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(timestamp));
  }

  private buildDeterministicTelemetryUnavailableAnswer(
    userQuery: string,
    primaryIntent: string,
    telemetryPrefiltered: boolean,
    telemetryMatchMode: TelemetryMatchMode,
    citations: ChatCitation[],
  ): { content: string; citations: ChatCitation[] } | null {
    if (primaryIntent !== 'telemetry_status') {
      return null;
    }

    if (
      telemetryPrefiltered ||
      telemetryMatchMode === 'sample' ||
      telemetryMatchMode === 'exact' ||
      telemetryMatchMode === 'direct' ||
      telemetryMatchMode === 'related'
    ) {
      return null;
    }

    const subject = this.buildTelemetryUnavailableSubject(userQuery);
    let content = `I couldn't confirm ${subject} from a direct matched telemetry reading.`;

    for (const citation of citations.filter((item) =>
      this.matchesManualRangeCitationSubject(userQuery, item),
    )) {
      const range = this.extractPreferredDocumentedRangeText(citation.snippet);
      if (!range) {
        continue;
      }

      const sourceLabel = citation.sourceTitle ?? 'the cited manual';
      const documentedSubject = this.buildManualRangeSubject(userQuery);
      content += ` The available manual evidence only confirms the documented ${documentedSubject} of ${range} [Manual: ${sourceLabel}], not the current live reading.`;
      return {
        content,
        citations: [citation],
      };
    }

    return {
      content,
      citations: [],
    };
  }

  private buildDeterministicManualSpecificationAnswer(
    userQuery: string,
    citations: ChatCitation[],
  ): string | null {
    const query = userQuery.toLowerCase();

    if (/\b(interval|how often|how frequently)\b/i.test(query)) {
      for (const citation of citations) {
        const interval = this.extractDocumentedIntervalText(citation.snippet);
        if (!interval) {
          continue;
        }

        const sourceLabel = citation.sourceTitle ?? 'the cited manual';
        return `The documented interval is ${interval} [Manual: ${sourceLabel}].`;
      }
    }

    if (
      /\b(normal|operating|specified)\b/i.test(query) &&
      /\b(range|limit|limits)\b/i.test(query)
    ) {
      for (const citation of citations.filter((item) =>
        this.matchesManualRangeCitationSubject(userQuery, item),
      )) {
        const range = this.extractPreferredDocumentedRangeText(citation.snippet);
        if (!range) {
          continue;
        }

        const subject = this.buildManualRangeSubject(userQuery);
        const sourceLabel = citation.sourceTitle ?? 'the cited manual';
        return `The documented ${subject} is ${range} [Manual: ${sourceLabel}].`;
      }
    }

    return null;
  }

  private matchesManualRangeCitationSubject(
    userQuery: string,
    citation: ChatCitation,
  ): boolean {
    const searchSpace = `${citation.sourceTitle ?? ''} ${citation.snippet ?? ''}`.toLowerCase();
    const query = userQuery.toLowerCase();

    if (/\bcoolant\b/.test(query) && /\btemperature\b/.test(query)) {
      return /\bcoolant\b/.test(searchSpace) && /\btemperature\b/.test(searchSpace);
    }

    if (/\boil\b/.test(query) && /\bpressure\b/.test(query)) {
      return /\boil\b/.test(searchSpace) && /\bpressure\b/.test(searchSpace);
    }

    if (/\bvoltage\b/.test(query)) {
      return /\bvoltage\b/.test(searchSpace);
    }

    if (/\btemperature\b/.test(query)) {
      return /\btemperature\b/.test(searchSpace);
    }

    if (/\bpressure\b/.test(query)) {
      return /\bpressure\b/.test(searchSpace);
    }

    return true;
  }

  private extractDocumentedIntervalText(snippet?: string): string | null {
    if (!snippet) {
      return null;
    }

    const normalized = snippet.replace(/\s+/g, ' ').trim();
    const patterns = [
      /\b(?:every|interval:?|service interval:?|oil change interval:?)[^\d]{0,20}(\d{2,5}\s*hours?(?:\s*(?:or|\/)\s*\d{1,2}\s*months?)?)/i,
      /\b(\d{2,5}\s*hours?\s*(?:or|\/)\s*\d{1,2}\s*months?)\b/i,
      /\bmust never exceed a period of (\d{1,2}\s*months?)\b/i,
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match?.[1]) {
        return match[1].replace(/\s+/g, ' ').trim();
      }
    }

    return null;
  }

  private extractDocumentedRangeText(snippet?: string): string | null {
    if (!snippet) {
      return null;
    }

    const normalized = snippet.replace(/\s+/g, ' ').trim();
    const match = normalized.match(
      /\b(\d{1,4}(?:\.\d+)?)\s*(?:-|to)\s*(\d{1,4}(?:\.\d+)?)\s*(°?\s*[CF]|bar|kPa|psi|V|A|rpm|%)\b/i,
    );

    if (!match) {
      return null;
    }

    return `${match[1]}-${match[2]} ${match[3].replace(/\s+/g, '').trim()}`;
  }

  private extractPreferredDocumentedRangeText(snippet?: string): string | null {
    if (!snippet) {
      return null;
    }

    const normalized = snippet.replace(/\s+/g, ' ').trim();
    const candidates = [
      ...normalized.matchAll(
        /\bbetween\s+(\d{1,4}(?:\.\d+)?)\s+and\s+(\d{1,4}(?:\.\d+)?)\s*((?:°|º|˚|В°)?\s*[CF]|bar|kPa|psi|V|A|rpm|%)\b/gi,
      ),
      ...normalized.matchAll(
        /\b(\d{1,4}(?:\.\d+)?)\s*(?:-|to)\s*(\d{1,4}(?:\.\d+)?)\s*((?:°|º|˚|В°)?\s*[CF]|bar|kPa|psi|V|A|rpm|%)\b/gi,
      ),
    ];

    if (candidates.length === 0) {
      return this.extractDocumentedRangeText(snippet);
    }

    const bestCandidate = candidates.sort((left, right) => {
      const unitPriorityDiff =
        this.getDocumentedRangeUnitPriority(right[3] ?? '') -
        this.getDocumentedRangeUnitPriority(left[3] ?? '');
      if (unitPriorityDiff !== 0) {
        return unitPriorityDiff;
      }

      return normalized.indexOf(left[0]) - normalized.indexOf(right[0]);
    })[0];

    if (!bestCandidate) {
      return this.extractDocumentedRangeText(snippet);
    }

    return `${bestCandidate[1]}-${bestCandidate[2]} ${this.normalizeDocumentedRangeUnit(
      bestCandidate[3] ?? '',
    )}`;
  }

  private buildManualRangeSubject(userQuery: string): string {
    const query = userQuery.toLowerCase();
    if (/\bcoolant\b/i.test(query) && /\btemperature\b/i.test(query)) {
      return 'normal coolant temperature range';
    }
    if (/\boil\b/i.test(query) && /\bpressure\b/i.test(query)) {
      return 'normal oil pressure range';
    }
    if (/\btemperature\b/i.test(query)) {
      return 'normal operating range';
    }

    return 'documented operating range';
  }

  private getDocumentedRangeUnitPriority(unit: string): number {
    const normalized = this.normalizeDocumentedRangeUnit(unit);
    if (normalized === '°C') {
      return 3;
    }
    if (normalized === '°F') {
      return 2;
    }
    return 1;
  }

  private normalizeDocumentedRangeUnit(unit: string): string {
    const normalized = unit.replace(/\s+/g, '').trim();
    if (/c$/i.test(normalized)) {
      return '°C';
    }
    if (/f$/i.test(normalized)) {
      return '°F';
    }
    return normalized;
  }

  private buildDeterministicAggregateTelemetryAnswer(
    userQuery: string,
    telemetry: Record<string, unknown>,
  ): string | null {
    const operation = this.detectTelemetryCalculationOperation(userQuery);
    if (!operation) {
      return null;
    }

    const entries = Object.entries(telemetry)
      .map(([label, value]) => this.parseNumericTelemetryEntry(label, value))
      .filter(
        (
          entry,
        ): entry is {
          label: string;
          value: number;
          normalizedLabel: string;
          unit: string | null;
        } => entry !== null,
      );

    if (entries.length < 2) {
      return null;
    }

    const unit = this.getConsistentAggregateUnit(entries);
    const normalizedQuery = this.normalizeAggregateTelemetryText(userQuery);
    if (!unit && this.hasExplicitUnitExpectation(normalizedQuery, entries)) {
      return null;
    }

    const fluid = this.detectAggregateFluid(userQuery);
    const orderedEntries = [...entries].sort((left, right) => {
      const tankRank =
        this.getAggregateTankOrder(left.normalizedLabel) -
        this.getAggregateTankOrder(right.normalizedLabel);
      return tankRank || left.label.localeCompare(right.label);
    });
    const valuesList = orderedEntries
      .map((entry) => `${entry.label}: ${this.formatAggregateNumber(entry.value)}`)
      .join('\n');
    const unitSuffix = unit ? ` ${unit}` : '';

    if (operation === 'sum') {
      const total = orderedEntries.reduce((sum, entry) => sum + entry.value, 0);
      const totalValue = this.formatAggregateNumber(total);
      const formula = orderedEntries
        .map((entry) => this.formatAggregateNumber(entry.value))
        .join(' + ');
      const subject = this.buildAggregateSubjectLabel(normalizedQuery, fluid);
      return [
        `The ${subject} from the current matched telemetry readings is ${totalValue}${unitSuffix} [Telemetry].`,
        '',
        'Matched telemetry:',
        ...orderedEntries.map(
          (entry) =>
            `- ${entry.label}: ${this.formatAggregateNumber(entry.value)}${unitSuffix}`,
        ),
        'Calculation:',
        `- Total = ${formula} = ${totalValue}${unitSuffix}`,
      ].join('\n');
    }

    if (operation === 'average') {
      const total = orderedEntries.reduce((sum, entry) => sum + entry.value, 0);
      const average = total / orderedEntries.length;
      const averageValue = this.formatAggregateNumber(average);
      const formula = orderedEntries
        .map((entry) => this.formatAggregateNumber(entry.value))
        .join(' + ');
      return [
        `The average of the current matched telemetry readings is ${averageValue}${unitSuffix} [Telemetry].`,
        '',
        'Matched telemetry:',
        valuesList,
        'Calculation:',
        `- Average = (${formula}) / ${orderedEntries.length} = ${averageValue}${unitSuffix}`,
      ].join('\n');
    }

    const selectedEntry =
      operation === 'max'
        ? orderedEntries.reduce((best, entry) =>
            entry.value > best.value ? entry : best,
          )
        : orderedEntries.reduce((best, entry) =>
            entry.value < best.value ? entry : best,
          );
    const qualifier = operation === 'max' ? 'highest' : 'lowest';
    return [
      `The ${qualifier} current matched telemetry reading is ${selectedEntry.label}: ${this.formatAggregateNumber(selectedEntry.value)}${unitSuffix} [Telemetry].`,
      '',
      'Matched telemetry:',
      valuesList,
    ].join('\n');
  }

  private shouldUseDeterministicTelemetryReadAnswer(query: string): boolean {
    const normalized = this.normalizeAggregateTelemetryText(query);
    if (!normalized) {
      return false;
    }

    return !/\b(based on|depending on|according to|recommended|recommendation|action|next step|next steps|what should i do|what do i do|why|alarm|fault|error|issue|problem|stopp?ed|not working|maintenance|service|procedure|steps?|how to|how do i|manual|documentation|replace|change|install|remove|inspect|troubleshoot(?:ing)?)\b/.test(
      normalized,
    ) && !/\b(normal|range|limit|limits|spec(?:ification)?|specified|operating)\b/.test(
      normalized,
    );
  }

  private buildDeterministicTelemetryReadAnswer(
    telemetry: Record<string, unknown>,
  ): string | null {
    const entries = Object.entries(telemetry)
      .map(([label, value]) =>
        this.parseDeterministicTelemetryReadEntry(label, value),
      )
      .filter(
        (
          entry,
        ): entry is {
          label: string;
          valueText: string;
          available: boolean;
        } => entry !== null,
      );

    if (entries.length === 0) {
      return null;
    }

    if (entries.length === 1) {
      const [entry] = entries;
      if (!entry.available) {
        return `I found the matched telemetry metric, but its current value is unavailable: ${entry.label}.`;
      }

      return `The current matched telemetry reading is ${entry.label}: ${entry.valueText} [Telemetry].`;
    }

    const lead = entries.some((entry) => entry.available)
      ? 'The current matched telemetry readings are [Telemetry]:'
      : 'I found the matched telemetry metrics, but their current values are unavailable:';

    return [
      lead,
      '',
      ...entries.map((entry) => `- ${entry.label}: ${entry.valueText}`),
    ].join('\n');
  }

  private parseDeterministicTelemetryReadEntry(
    label: string,
    value: unknown,
  ): {
    label: string;
    valueText: string;
    available: boolean;
  } | null {
    const primaryLabel = label.split(' вЂ” ')[0]?.trim() ?? label.trim();
    if (!primaryLabel) {
      return null;
    }

    const unitMatch = label.match(/Unit:\s*([^\n\rвЂ”]+)/i);
    const unit = unitMatch?.[1]?.trim() ?? null;
    const valueText = this.formatDeterministicTelemetryValue(value, unit);

    return {
      label: primaryLabel,
      valueText,
      available: valueText !== 'unavailable',
    };
  }

  private formatDeterministicTelemetryValue(
    value: unknown,
    unit: string | null,
  ): string {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return 'unavailable';
      }

      return `${this.formatAggregateNumber(value)}${unit ? ` ${unit}` : ''}`;
    }

    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (
        !trimmed ||
        trimmed.toLowerCase() === 'null' ||
        trimmed.toLowerCase() === 'undefined'
      ) {
        return 'unavailable';
      }

      const numericValue = Number.parseFloat(trimmed);
      if (/^-?\d+(?:\.\d+)?$/.test(trimmed) && Number.isFinite(numericValue)) {
        return `${this.formatAggregateNumber(numericValue)}${unit ? ` ${unit}` : ''}`;
      }

      return trimmed;
    }

    return 'unavailable';
  }

  private detectAggregateFluid(
    query: string,
  ): 'fuel' | 'oil' | 'water' | 'coolant' | 'def' | null {
    const normalized = this.normalizeAggregateTelemetryText(query);
    if (/\bfuel\b/.test(normalized)) return 'fuel';
    if (/\boil\b/.test(normalized)) return 'oil';
    if (/\bcoolant\b/.test(normalized)) return 'coolant';
    if (/\b(def|urea)\b/.test(normalized)) return 'def';
    if (/\b(water|fresh water|seawater)\b/.test(normalized)) return 'water';
    return null;
  }

  private isFuelForecastQuery(query: string): boolean {
    const normalized = this.normalizeAggregateTelemetryText(query);
    return (
      /\bfuel\b/.test(normalized) &&
      (/\b(forecast|budget|need|order)\b/.test(normalized) ||
        /\b(next|coming|upcoming)\s+month\b/.test(normalized))
    );
  }

  private buildFuelForecastHistoricalBasisQuery(query: string): string {
    const normalized = this.normalizeAggregateTelemetryText(query);
    const agoMatch = normalized.match(
      /\b(\d+)\s+(hour|hours|day|days|week|weeks|month|months)\s+ago\b/i,
    );
    if (agoMatch) {
      return `How much fuel was used over the last ${agoMatch[1]} ${agoMatch[2]}?`;
    }

    const rangeMatch = normalized.match(
      /\b(?:last|past|previous|over the last)\s+(\d+)\s+(hour|hours|day|days|week|weeks|month|months)\b/i,
    );
    if (rangeMatch) {
      return `How much fuel was used over the last ${rangeMatch[1]} ${rangeMatch[2]}?`;
    }

    if (/\blast month\b/i.test(normalized)) {
      return 'How much fuel was used over the last month?';
    }

    if (/\bthis month\b/i.test(normalized)) {
      return 'How much fuel was used over this month?';
    }

    return 'How much fuel was used over the last 30 days?';
  }

  private describeFuelForecastBasis(
    userQuery: string,
    historyBasisQuery: string,
  ): string {
    const normalized = this.normalizeAggregateTelemetryText(
      `${userQuery} ${historyBasisQuery}`,
    );

    if (/\blast month\b/i.test(normalized)) {
      return 'the last month';
    }

    const rangeMatch = normalized.match(
      /\blast\s+(\d+)\s+(hour|hours|day|days|week|weeks|month|months)\b/i,
    );
    if (rangeMatch) {
      return `the last ${rangeMatch[1]} ${rangeMatch[2]}`;
    }

    return 'the last 30 days';
  }

  private extractHistoricalFuelLiters(content: string): number | null {
    const match = content.match(/\bwas\s+([\d,]+(?:\.\d+)?)\s+liters\b/i);
    if (!match?.[1]) {
      return null;
    }

    const numeric = Number.parseFloat(match[1].replace(/,/g, ''));
    return Number.isFinite(numeric) ? numeric : null;
  }

  private sumCurrentFuelTankTelemetry(
    telemetry: Record<string, unknown>,
  ): number | null {
    const entries = Object.entries(telemetry)
      .map(([label, value]) => this.parseNumericTelemetryEntry(label, value))
      .filter(
        (
          entry,
        ): entry is {
          label: string;
          value: number;
          normalizedLabel: string;
          unit: string | null;
        } => entry !== null,
      )
      .filter(
        (entry) =>
          /\bfuel\s+tank\b/i.test(entry.normalizedLabel) &&
          !/\b(used|consumed|consumption|rate|flow|pressure|temp|temperature)\b/i.test(
            entry.normalizedLabel,
          ),
      );

    if (entries.length === 0) {
      return null;
    }

    return entries.reduce((sum, entry) => sum + entry.value, 0);
  }

  private detectTelemetryCalculationOperation(
    query: string,
  ): 'sum' | 'average' | 'min' | 'max' | null {
    const normalized = this.normalizeAggregateTelemetryText(query);

    if (/\b(average|avg|mean)\b/.test(normalized)) {
      return 'average';
    }

    if (/\b(max|maximum|highest|peak|largest|greatest)\b/.test(normalized)) {
      return 'max';
    }

    if (/\b(min|minimum|lowest|smallest|least)\b/.test(normalized)) {
      return 'min';
    }

    if (
      /\b(how much|how many|total|sum|overall|combined|together|calculate)\b/.test(
        normalized,
      ) ||
      /\b(onboard|remaining|left|available)\b/.test(normalized)
    ) {
      return 'sum';
    }

    return null;
  }

  private parseNumericTelemetryEntry(
    label: string,
    value: unknown,
  ): {
    label: string;
    value: number;
    normalizedLabel: string;
    unit: string | null;
  } | null {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseFloat(value)
          : Number.NaN;
    if (!Number.isFinite(numericValue)) {
      return null;
    }

    const primaryLabel = label.split(' — ')[0]?.trim() ?? label.trim();
    const normalizedLabel = this.normalizeAggregateTelemetryText(primaryLabel);
    const unitMatch = label.match(/Unit:\s*([^\n\r—]+)/i);
    return {
      label: primaryLabel,
      value: numericValue,
      normalizedLabel,
      unit: unitMatch?.[1]?.trim() ?? null,
    };
  }

  private buildAggregateSubjectLabel(
    normalizedQuery: string,
    fluid: 'fuel' | 'oil' | 'water' | 'coolant' | 'def' | null,
  ): string {
    if (fluid === 'fuel' && /\bonboard\b/.test(normalizedQuery)) {
      return 'total fuel onboard';
    }

    if (fluid === 'oil' && /\bonboard\b/.test(normalizedQuery)) {
      return 'total oil onboard';
    }

    if (fluid === 'coolant' && /\bonboard\b/.test(normalizedQuery)) {
      return 'total coolant onboard';
    }

    if (fluid === 'def' && /\bonboard\b/.test(normalizedQuery)) {
      return 'total DEF onboard';
    }

    return 'combined total';
  }

  private getAggregateTankOrder(normalizedLabel: string): number {
    const match = normalizedLabel.match(/\btank\s+(\d{1,3})([a-z])?\b/i);
    if (!match) {
      return Number.MAX_SAFE_INTEGER;
    }

    const number = Number.parseInt(match[1], 10);
    const side = match[2]?.toLowerCase() ?? '';
    const sideOffset = side === 'p' ? 1 : side === 's' ? 2 : 3;
    return number * 10 + sideOffset;
  }

  private getConsistentAggregateUnit(
    entries: Array<{ unit: string | null }>,
  ): string | null {
    const units = [...new Set(entries.map((entry) => entry.unit).filter(Boolean))];
    if (units.length === 0) {
      return null;
    }
    if (units.length !== 1) {
      return null;
    }

    const [unit] = units;
    if (!unit) {
      return null;
    }

    return /^\s*l\s*$/i.test(unit) || /^lit(er|re)s?$/i.test(unit)
      ? 'liters'
      : unit;
  }

  private hasExplicitUnitExpectation(
    normalizedQuery: string,
    entries: Array<{ normalizedLabel: string }>,
  ): boolean {
    const expectsPhysicalQuantity =
      /\b(temperature|temp|pressure|voltage|current|amps?|amp|load|rpm|speed|flow|rate|hours?|runtime|level|quantity|volume)\b/.test(
        normalizedQuery,
      );
    if (!expectsPhysicalQuantity) {
      return false;
    }

    return entries.some((entry) =>
      /\b(temperature|temp|pressure|voltage|current|amps?|amp|load|rpm|speed|flow|rate|hours?|runtime|level|quantity|volume)\b/.test(
        entry.normalizedLabel,
      ),
    );
  }

  private formatAggregateNumber(value: number): string {
    return Number.isInteger(value)
      ? value.toLocaleString('en-US')
      : value.toLocaleString('en-US', {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        });
  }

  private normalizeAggregateTelemetryText(value: string): string {
    return value
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_./:-]+/g, ' ')
      .replace(/[^a-zA-Z0-9\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  private buildTelemetryUnavailableSubject(userQuery: string): string {
    const cleaned = userQuery.replace(/\?+$/g, '').trim();
    const candidate = cleaned
      .replace(/^(what\s+is|what's|whats|show\s+me|give\s+me|tell\s+me)\s+/i, '')
      .trim();

    if (
      candidate &&
      /\b(current|currently|reading|value|temperature|temp|pressure|level|voltage|load|rpm|speed|flow|rate|runtime|hours?|position|location)\b/i.test(
        candidate,
      )
    ) {
      return /^the\s+/i.test(candidate) ? candidate : `the ${candidate}`;
    }

    return 'the current requested reading';
  }

  private selectTelemetryContextForLlm(
    queryPlan: ChatQueryPlan,
    userQuery: string,
    telemetry: Record<string, unknown>,
    telemetryPrefiltered: boolean,
    telemetryMatchMode: TelemetryMatchMode,
  ): {
    telemetry: Record<string, unknown>;
    telemetryPrefiltered: boolean;
    telemetryMatchMode: TelemetryMatchMode;
  } {
    if (!this.shouldKeepTelemetryForLlm(queryPlan, userQuery)) {
      return {
        telemetry: {},
        telemetryPrefiltered: false,
        telemetryMatchMode: 'none',
      };
    }

    return {
      telemetry,
      telemetryPrefiltered,
      telemetryMatchMode,
    };
  }

  private shouldKeepTelemetryForLlm(
    queryPlan: ChatQueryPlan,
    userQuery: string,
  ): boolean {
    switch (queryPlan.primaryIntent) {
      case 'telemetry_list':
      case 'telemetry_status':
      case 'telemetry_history':
      case 'analytics_forecast':
      case 'next_due_calculation':
      case 'maintenance_due_now':
      case 'last_maintenance':
        return true;
      case 'maintenance_procedure':
        return this.isCurrentTelemetryGuidedQuery(userQuery);
      case 'troubleshooting':
        return this.isCurrentTelemetryGuidedQuery(userQuery);
      case 'manual_specification':
      case 'parts_fluids_consumables':
      case 'certificate_status':
      case 'regulation_compliance':
        return false;
      default:
        return false;
    }
  }

  private shouldLookupCurrentTelemetry(
    queryPlan: ChatQueryPlan,
    userQuery: string,
  ): boolean {
    if (this.isCurrentInventoryTelemetryQuery(userQuery)) {
      return true;
    }

    switch (queryPlan.primaryIntent) {
      case 'telemetry_list':
      case 'telemetry_status':
      case 'analytics_forecast':
      case 'next_due_calculation':
      case 'maintenance_due_now':
      case 'last_maintenance':
        return true;
      case 'maintenance_procedure':
      case 'troubleshooting':
        return this.isCurrentTelemetryGuidedQuery(userQuery);
      case 'parts_fluids_consumables':
        return this.isCurrentInventoryTelemetryQuery(userQuery);
      case 'general':
        return (
          /\b(from\s+telemetry|telemetry\s+only|from\s+metrics)\b/i.test(
            userQuery,
          ) || this.isCurrentTelemetryGuidedQuery(userQuery)
        );
      default:
        return false;
    }
  }

  private shouldReturnTelemetryClarification(
    queryPlan: ChatQueryPlan,
    userQuery: string,
  ): boolean {
    if (/\b(from\s+telemetry|telemetry\s+only|from\s+metrics)\b/i.test(userQuery)) {
      return true;
    }

    return (
      queryPlan.primaryIntent === 'telemetry_status' ||
      queryPlan.primaryIntent === 'telemetry_list'
    );
  }

  private isTelemetryOnlyQuery(
    queryPlan: ChatQueryPlan,
    userQuery: string,
    telemetryMatchMode: TelemetryMatchMode,
    documentationIntentPattern: RegExp,
  ): boolean {
    if (/\bfrom\s+telemetry\b|\btelemetry\s+only\b|\bfrom\s+metrics\b/i.test(userQuery)) {
      return true;
    }

    if (queryPlan.primaryIntent === 'telemetry_list') {
      return true;
    }

    if (queryPlan.primaryIntent !== 'telemetry_status') {
      return false;
    }

    return (
      telemetryMatchMode === 'sample' ||
      ((telemetryMatchMode === 'exact' || telemetryMatchMode === 'direct') &&
        !documentationIntentPattern.test(userQuery))
    );
  }

  private shouldUseDeterministicTelemetryAnswer(
    queryPlan: ChatQueryPlan,
    userQuery: string,
  ): boolean {
    if (/\bfrom\s+telemetry\b|\btelemetry\s+only\b|\bfrom\s+metrics\b/i.test(userQuery)) {
      return true;
    }

    if (this.isCurrentInventoryTelemetryQuery(userQuery)) {
      return true;
    }

    switch (queryPlan.primaryIntent) {
      case 'telemetry_status':
      case 'telemetry_list':
        return true;
      case 'parts_fluids_consumables':
        return this.isCurrentInventoryTelemetryQuery(userQuery);
      default:
        return false;
    }
  }

  private isCurrentInventoryTelemetryQuery(userQuery: string): boolean {
    const normalized = userQuery.toLowerCase();
    if (
      /\b(next\s+month|next\s+week|forecast|budget|trend|historical|history|over\s+the\s+last|last\s+\d+\s+(?:days?|weeks?|months?)|need\s+to\s+order|order)\b/i.test(
        normalized,
      )
    ) {
      return false;
    }

    return (
      /\b(onboard|on\s+board|in\s+tanks|tank\s+levels?|all\s+fuel\s+tanks|remaining|available)\b/i.test(
        normalized,
      ) ||
      (/\b(how\s+many|how\s+much|total|combined|sum)\b/i.test(normalized) &&
        /\b(fuel|oil|water|coolant)\b/i.test(normalized))
    );
  }

  private isCurrentTelemetryGuidedQuery(userQuery: string): boolean {
    return /\b(current|currently|reading|value|measured|showing|reads?\s+\d+(?:\.\d+)?|is\s+\d+(?:\.\d+)?|at\s+\d+(?:\.\d+)?)\b/i.test(
      userQuery,
    );
  }
}
