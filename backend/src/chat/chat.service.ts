import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmGeneratedResponse, LlmService } from './llm.service';
import { MetricsService } from '../metrics/metrics.service';
import { CreateChatSessionDto } from './dto/create-chat-session.dto';
import { SendMessageDto } from './dto/send-message.dto';
import {
  ChatSessionResponseDto,
  ChatMessageResponseDto,
} from './dto/chat-response.dto';
import { ChatDocumentationService } from './chat-documentation.service';
import {
  ChatAnswerRoute,
  ChatCitation,
  ChatHistoryMessage,
  ChatNormalizedQuery,
} from './chat.types';
import type { DocumentationSemanticQuery } from '../semantic/semantic.types';
import { sortChatSessions } from './chat-session-order';
import {
  ChatQueryPlan,
  ChatQueryPlannerService,
} from './chat-query-planner.service';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatQueryNormalizationService } from './chat-query-normalization.service';

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

type TelemetryMatchMode = 'none' | 'sample' | 'exact' | 'direct' | 'related';

interface DeterministicContactEntry {
  name: string;
  role?: string;
  email?: string;
  phone?: string;
  citation: ChatCitation;
}

interface DeterministicTankCapacityEntry {
  label: string;
  capacity: string;
  citation: ChatCitation;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly queryPlanner = new ChatQueryPlannerService();
  private readonly documentationQueryService =
    new ChatDocumentationQueryService();
  private readonly queryNormalizationService =
    new ChatQueryNormalizationService(this.documentationQueryService);

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
              include: {
                shipManual: { select: { shipId: true, category: true } },
              },
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
          include: { shipManual: { select: { shipId: true, category: true } } },
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
          include: { shipManual: { select: { shipId: true, category: true } } },
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
    let llmErrorFallbackContext: {
      normalizedQuery: ChatNormalizedQuery;
      ragflowContext: Record<string, unknown>;
      contextReferences: ChatCitation[];
    } | null = null;
    try {
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

      const messageHistory = [...(session?.messages ?? [])]
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
      const normalizedQuery = this.queryNormalizationService.normalizeTurn({
        userQuery,
        messageHistory,
      });

      const documentationContext =
        await this.documentationService.prepareDocumentationContext({
          shipId,
          role,
          userQuery,
          messageHistory,
          normalizedQuery,
        });

      const {
        citations,
        analysisCitations,
        previousUserQuery,
        retrievalQuery,
        resolvedSubjectQuery: exactResolvedSubjectQuery,
        answerQuery,
        semanticQuery,
        documentationFollowUpState,
        retrievalTrace,
        sourceLockActive,
      } = documentationContext;
      const resolvedSubjectQuery =
        exactResolvedSubjectQuery ??
        (retrievalQuery !== userQuery ? retrievalQuery : undefined);
      const effectiveUserQuery = answerQuery ?? userQuery;
      const effectiveNormalizedQuery: ChatNormalizedQuery = {
        ...normalizedQuery,
        retrievalQuery,
        effectiveQuery: effectiveUserQuery,
      };
      const documentationTurnContext = {
        ...(semanticQuery ? { documentationSemanticQuery: semanticQuery } : {}),
        ...(documentationFollowUpState ? { documentationFollowUpState } : {}),
        ...(retrievalTrace
          ? { documentationRetrievalTrace: retrievalTrace }
          : {}),
        ...(sourceLockActive !== undefined
          ? { documentationSourceLockActive: sourceLockActive }
          : {}),
      };
      this.logger.debug(
        `Chat query context session=${sessionId} ship=${shipId ?? 'none'} userQuery="${this.truncateForLog(
          userQuery,
        )}" effectiveUserQuery="${this.truncateForLog(
          effectiveUserQuery,
        )}" resolvedSubjectQuery="${this.truncateForLog(
          resolvedSubjectQuery ?? '',
        )}" normalizedQuery=${JSON.stringify(effectiveNormalizedQuery)}`,
      );
      const queryPlan = this.queryPlanner.planQuery(
        effectiveNormalizedQuery,
        resolvedSubjectQuery,
      );
      const telemetryIntentQuery = this.buildTelemetryIntentQuery({
        userQuery: effectiveUserQuery,
        retrievalQuery,
        resolvedSubjectQuery,
        normalizedQuery: effectiveNormalizedQuery,
      });

      if (
        documentationContext.needsClarification &&
        documentationContext.clarificationQuestion
      ) {
        const clarificationState =
          documentationContext.clarificationState ??
          this.documentationQueryService.buildClarificationState({
            clarificationDomain: 'documentation',
            pendingQuery:
              documentationContext.pendingClarificationQuery ??
              userQuery.trim(),
            clarificationReason:
              documentationContext.clarificationReason ??
              'underspecified_query',
            normalizedQuery: effectiveNormalizedQuery,
          });
        return this.addRoutedAssistantMessage({
          sessionId,
          content: documentationContext.clarificationQuestion,
          route: 'clarification',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['documentation:clarification'],
          ragflowContext: {
            ...documentationTurnContext,
            awaitingClarification: true,
            clarificationDomain: clarificationState.clarificationDomain,
            pendingClarificationQuery: clarificationState.pendingQuery,
            clarificationReason:
              documentationContext.clarificationReason ??
              'underspecified_query',
            clarificationState,
            ...(documentationContext.clarificationActions &&
            documentationContext.clarificationActions.length > 0
              ? {
                  clarificationActions:
                    documentationContext.clarificationActions,
                }
              : {}),
          },
          contextReferences: [],
        });
      }

      const carriedForwardDocumentationCitations =
        this.getCarriedForwardDocumentationCitations({
          userQuery,
          normalizedQuery: effectiveNormalizedQuery,
          previousUserQuery,
          messageHistory,
          sourceLockActive,
          lockedManualId: documentationFollowUpState?.lockedManualId,
        });
      const carriedForwardSummaryDocumentationCitations =
        this.getCarriedForwardSummaryDocumentationCitations({
          userQuery,
          normalizedQuery: effectiveNormalizedQuery,
          messageHistory,
        });
      const hasDocumentationEvidenceForLockedSource =
        citations.length > 0 ||
        carriedForwardDocumentationCitations.length > 0 ||
        carriedForwardSummaryDocumentationCitations.length > 0;
      if (sourceLockActive && !hasDocumentationEvidenceForLockedSource) {
        return this.addRoutedAssistantMessage({
          sessionId,
          content:
            "I couldn't find supporting documentation in the selected source for that question. I won't answer from unrelated telemetry or other documents unless you choose a different source or ask me to search more broadly.",
          route: 'deterministic_document',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['documentation:source_lock_no_evidence'],
          ragflowContext: {
            ...documentationTurnContext,
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            noDocumentation: true,
            sourceLockNoEvidence: true,
          },
          contextReferences: [],
        });
      }

      const historicalTelemetryMatch =
        await this.resolveHistoricalTelemetryForContext({
          shipId,
          role,
          sessionId,
          userQuery,
          effectiveUserQuery,
          resolvedSubjectQuery,
          normalizedQuery: effectiveNormalizedQuery,
        });

      if (historicalTelemetryMatch) {
        const { resolution: historicalTelemetryResolution } =
          historicalTelemetryMatch;

        if (
          historicalTelemetryResolution.kind === 'clarification' &&
          historicalTelemetryResolution.clarificationQuestion
        ) {
          const clarificationState =
            this.documentationQueryService.buildClarificationState({
              clarificationDomain: 'historical_telemetry',
              pendingQuery:
                historicalTelemetryResolution.pendingQuery ?? userQuery.trim(),
              clarificationReason: 'historical_telemetry_query',
              normalizedQuery: effectiveNormalizedQuery,
              resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            });
          return this.addRoutedAssistantMessage({
            sessionId,
            content: historicalTelemetryResolution.clarificationQuestion,
            route: 'clarification',
            normalizedQuery: effectiveNormalizedQuery,
            routeTrace: ['historical_telemetry:clarification'],
            ragflowContext: {
              awaitingClarification: true,
              clarificationDomain: clarificationState.clarificationDomain,
              pendingClarificationQuery: clarificationState.pendingQuery,
              clarificationReason: 'historical_telemetry_query',
              clarificationState,
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
            contextReferences: [],
          });
        }

        if (
          historicalTelemetryResolution.kind === 'answer' &&
          historicalTelemetryResolution.content
        ) {
          return this.addRoutedAssistantMessage({
            sessionId,
            content: historicalTelemetryResolution.content,
            route: 'historical_telemetry',
            normalizedQuery: effectiveNormalizedQuery,
            routeTrace: ['historical_telemetry:answer'],
            ragflowContext: {
              historicalTelemetry: true,
              ...(historicalTelemetryMatch.shipName
                ? { telemetryShips: [historicalTelemetryMatch.shipName] }
                : {}),
              resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
              telemetryFollowUpQuery: telemetryIntentQuery,
            },
            contextReferences: [],
          });
        }
      }

      if (
        this.shouldBlockCurrentTelemetryBecauseHistoricalIntent(
          queryPlan,
          effectiveNormalizedQuery,
          historicalTelemetryMatch?.resolution.kind ?? 'none',
        )
      ) {
        this.logger.debug(
          `Blocking current telemetry fallback for unresolved historical query="${effectiveUserQuery}"`,
        );
        const clarificationState =
          this.documentationQueryService.buildClarificationState({
            clarificationDomain: 'historical_telemetry',
            pendingQuery: userQuery.trim(),
            clarificationReason: 'historical_current_fallback_blocked',
            normalizedQuery: effectiveNormalizedQuery,
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
          });
        return this.addRoutedAssistantMessage({
          sessionId,
          content:
            'I could not resolve the requested historical telemetry from the available data, so I am not substituting current values as a fallback. Please restate the metric or provide a more specific time window.',
          route: 'clarification',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['historical_telemetry:fallback_blocked'],
          ragflowContext: {
            awaitingClarification: true,
            clarificationDomain: clarificationState.clarificationDomain,
            pendingClarificationQuery: clarificationState.pendingQuery,
            clarificationReason: 'historical_current_fallback_blocked',
            clarificationState,
            currentTelemetryFallbackAllowed: false,
            currentTelemetryFallbackReason:
              'historical_intent_requires_explicit_downgrade',
            historicalTelemetry: true,
            ...(resolvedSubjectQuery
              ? { resolvedSubjectQuery }
              : retrievalQuery
                ? { resolvedSubjectQuery: retrievalQuery }
                : {}),
          },
          contextReferences: [],
        });
      }

      let telemetry: Record<string, unknown> = {};
      let telemetryPrefiltered = false;
      let telemetryMatchMode: TelemetryMatchMode = 'none';
      let telemetryMatchedMetrics = 0;
      let telemetryClarification: TelemetryClarification | null = null;
      const telemetryShips: string[] = [];
      const shouldLookupCurrentTelemetry =
        !this.shouldPreferDocumentationOverCurrentTelemetry(
          queryPlan,
          telemetryIntentQuery,
          semanticQuery,
        ) &&
        this.shouldLookupCurrentTelemetry(
          queryPlan,
          telemetryIntentQuery,
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
          telemetryMatchedMetrics = telemetryContext.matchedMetrics;
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
              telemetryMatchedMetrics += telemetryContext.matchedMetrics;
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
        const clarificationState =
          this.documentationQueryService.buildClarificationState({
            clarificationDomain: 'current_telemetry',
            pendingQuery: telemetryClarification.pendingQuery,
            clarificationReason: 'related_telemetry_options',
            normalizedQuery: effectiveNormalizedQuery,
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
          });
        return this.addRoutedAssistantMessage({
          sessionId,
          content: telemetryClarification.question,
          route: 'clarification',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['current_telemetry:clarification'],
          ragflowContext: {
            awaitingClarification: true,
            clarificationDomain: clarificationState.clarificationDomain,
            pendingClarificationQuery: clarificationState.pendingQuery,
            clarificationReason: 'related_telemetry_options',
            clarificationState,
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
          contextReferences: [],
        });
      }

      const documentationIntentPattern =
        /\b(based\s+on|recommended|recommendation|action|next\s+step|what\s+should\s+i\s+do|what\s+do\s+i\s+do|procedure|steps?|how\s+to|how\s+do\s+i|manual|documentation|according\s+to\s+(?:the\s+)?(?:manual|documentation|docs?|handbook|guide|procedure|spec(?:ification)?)|normal|range|limit|limits|specified|operating)\b/i;
      const telemetryOnlyQuery = this.isTelemetryOnlyQuery(
        queryPlan,
        telemetryIntentQuery,
        telemetryMatchMode,
        documentationIntentPattern,
      );

      const citationsForAnswer = telemetryOnlyQuery
        ? []
        : carriedForwardDocumentationCitations.length > 0
          ? carriedForwardDocumentationCitations
          : carriedForwardSummaryDocumentationCitations.length > 0
            ? carriedForwardSummaryDocumentationCitations
            : citations;
      const llmTelemetryContext = this.selectTelemetryContextForLlm(
        queryPlan,
        telemetryIntentQuery,
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
        return this.addRoutedAssistantMessage({
          sessionId,
          content: deterministicForecastAnswer,
          route: 'analytics_forecast',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['analytics_forecast:deterministic'],
          ragflowContext: {
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
            noDocumentation: true,
            usedHistoricalTelemetry: true,
            usedCurrentTelemetry:
              this.sumCurrentFuelTankTelemetry(telemetry) !== null,
          },
          contextReferences: [],
        });
      }

      const deterministicCertificateAnswer =
        this.buildDeterministicCertificateStatusAnswer(
          effectiveUserQuery,
          queryPlan.primaryIntent,
          this.isBroadCertificateSoonQuery(effectiveUserQuery)
            ? (analysisCitations ?? citationsForAnswer)
            : citationsForAnswer,
        );
      if (deterministicCertificateAnswer) {
        return this.addRoutedAssistantMessage({
          sessionId,
          content: deterministicCertificateAnswer.content,
          route: 'deterministic_certificate',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['certificate:deterministic'],
          ragflowContext: {
            ...documentationTurnContext,
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
          },
          contextReferences: deterministicCertificateAnswer.citations,
        });
      }

      const deterministicContactAnswer =
        this.shouldBypassDeterministicContactFollowUp(
          userQuery,
          effectiveNormalizedQuery,
          carriedForwardDocumentationCitations,
        )
          ? null
          : this.buildDeterministicContactLookupAnswer(
              userQuery,
              effectiveUserQuery,
              citationsForAnswer,
            );
      if (deterministicContactAnswer) {
        return this.addRoutedAssistantMessage({
          sessionId,
          content: deterministicContactAnswer.content,
          route: 'deterministic_contact',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['contact:deterministic'],
          ragflowContext: {
            ...documentationTurnContext,
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
          },
          contextReferences: deterministicContactAnswer.citations,
        });
      }

      const deterministicDocumentationAnswer =
        this.buildDeterministicDocumentationAnswer(
          effectiveUserQuery,
          queryPlan.primaryIntent,
          citationsForAnswer,
        );
      if (deterministicDocumentationAnswer) {
        return this.addRoutedAssistantMessage({
          sessionId,
          content: deterministicDocumentationAnswer.content,
          route: 'deterministic_document',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['documentation:deterministic'],
          ragflowContext: {
            ...documentationTurnContext,
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
          },
          contextReferences:
            deterministicDocumentationAnswer.citations ?? citationsForAnswer,
        });
      }

      const deterministicTelemetryUnavailableAnswer =
        this.buildDeterministicTelemetryUnavailableAnswer(
          telemetryIntentQuery,
          queryPlan.primaryIntent,
          telemetryPrefiltered,
          telemetryMatchMode,
          telemetryMatchedMetrics,
          telemetryOnlyQuery,
          citationsForAnswer,
        );
      if (deterministicTelemetryUnavailableAnswer) {
        return this.addRoutedAssistantMessage({
          sessionId,
          content: deterministicTelemetryUnavailableAnswer.content,
          route: 'current_telemetry',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['current_telemetry:deterministic_unavailable'],
          ragflowContext: {
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
          },
          contextReferences: deterministicTelemetryUnavailableAnswer.citations,
        });
      }

      const deterministicTelemetryAnswer =
        this.buildDeterministicTelemetryAnswer(
          queryPlan,
          telemetryIntentQuery,
          telemetry,
          telemetryPrefiltered,
          telemetryMatchMode,
          telemetryMatchedMetrics,
        );
      if (deterministicTelemetryAnswer) {
        return this.addRoutedAssistantMessage({
          sessionId,
          content: deterministicTelemetryAnswer,
          route: 'current_telemetry',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['current_telemetry:deterministic_answer'],
          ragflowContext: {
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
            noDocumentation: true,
            usedDocumentation: false,
            telemetryFollowUpQuery: telemetryIntentQuery,
          },
          contextReferences: [],
        });
      }

      if (telemetryOnlyQuery) {
        return this.addRoutedAssistantMessage({
          sessionId,
          content:
            "I couldn't determine the requested answer from direct matched telemetry data.",
          route: 'current_telemetry',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['current_telemetry:telemetry_only_unavailable'],
          ragflowContext: {
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            ...(telemetryShips.length > 0
              ? { telemetryShips: [...new Set(telemetryShips)] }
              : {}),
            noDocumentation: true,
          },
          contextReferences: [],
        });
      }

      if (
        this.shouldFailClosedForDocumentationMiss({
          queryPlan,
          userQuery: effectiveUserQuery,
          semanticQuery,
          citationsForAnswer,
          telemetryOnlyQuery,
          llmTelemetryContext,
        })
      ) {
        return this.addRoutedAssistantMessage({
          sessionId,
          content:
            "I couldn't find supporting documentation for that question in the available manuals. I won't answer from general knowledge unless you ask me to search more broadly or choose a specific source.",
          route: 'deterministic_document',
          normalizedQuery: effectiveNormalizedQuery,
          routeTrace: ['documentation:no_evidence'],
          ragflowContext: {
            ...documentationTurnContext,
            resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
            noDocumentation: true,
            documentationNoEvidence: true,
            usedCurrentTelemetry: false,
          },
          contextReferences: [],
        });
      }

      const previousLlmResponseId =
        this.getLatestLlmResponseIdFromRecentAssistant(messageHistory);
      llmErrorFallbackContext = {
        normalizedQuery: effectiveNormalizedQuery,
        ragflowContext: {
          ...documentationTurnContext,
          resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
          ...(telemetryShips.length > 0
            ? { telemetryShips: [...new Set(telemetryShips)] }
            : {}),
          ...(citationsForAnswer.length === 0 && !telemetryOnlyQuery
            ? { noDocumentation: true }
            : {}),
          usedDocumentation: citationsForAnswer.length > 0,
          usedCurrentTelemetry:
            Object.keys(llmTelemetryContext.telemetry).length > 0,
          ...(previousLlmResponseId
            ? { llmPreviousResponseId: previousLlmResponseId }
            : {}),
        },
        contextReferences: citationsForAnswer,
      };
      const response = await this.llmService.generateResponse({
        userQuery: effectiveUserQuery,
        previousUserQuery: answerQuery
          ? undefined
          : retrievalQuery !== userQuery
            ? previousUserQuery
            : undefined,
        previousResponseId: previousLlmResponseId,
        resolvedSubjectQuery,
        structuredConversationState:
          this.buildStructuredConversationState(messageHistory),
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
        chatHistory: messageHistory?.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      });
      const llmResult = this.normalizeGeneratedLlmResponse(response);

      return this.addRoutedAssistantMessage({
        sessionId,
        content: llmResult.content,
        route: 'llm_generation',
        normalizedQuery: effectiveNormalizedQuery,
        routeTrace: ['llm:generation'],
        ragflowContext: {
          ...documentationTurnContext,
          resolvedSubjectQuery: resolvedSubjectQuery ?? retrievalQuery,
          ...(telemetryShips.length > 0
            ? { telemetryShips: [...new Set(telemetryShips)] }
            : {}),
          ...(citationsForAnswer.length === 0 && !telemetryOnlyQuery
            ? { noDocumentation: true }
            : {}),
          usedDocumentation: citationsForAnswer.length > 0,
          usedCurrentTelemetry:
            Object.keys(llmTelemetryContext.telemetry).length > 0,
          ...(llmResult.responseId
            ? { llmResponseId: llmResult.responseId }
            : {}),
          ...(previousLlmResponseId
            ? { llmPreviousResponseId: previousLlmResponseId }
            : {}),
        },
        contextReferences: citationsForAnswer,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      const fallback = `I encountered an issue processing your query: ${errorMessage}. Please try again or contact support.`;
      const fallbackNormalizedQuery =
        llmErrorFallbackContext?.normalizedQuery ??
        this.queryNormalizationService.normalizeTurn({
          userQuery,
        });
      return this.addRoutedAssistantMessage({
        sessionId,
        content: fallback,
        route: 'llm_generation',
        normalizedQuery: fallbackNormalizedQuery,
        routeTrace: llmErrorFallbackContext
          ? ['llm:error_fallback']
          : ['error:fallback'],
        ragflowContext: {
          ...(llmErrorFallbackContext?.ragflowContext ?? {}),
          usedLlm: false,
          llmGenerationError: true,
          llmGenerationErrorMessage: this.truncateForLog(errorMessage),
        },
        contextReferences:
          llmErrorFallbackContext?.contextReferences ?? [],
      });
    }
  }

  private addRoutedAssistantMessage(params: {
    sessionId: string;
    content: string;
    route: ChatAnswerRoute;
    normalizedQuery: ChatNormalizedQuery;
    routeTrace?: string[];
    ragflowContext?: Record<string, unknown>;
    contextReferences?: ChatCitation[];
  }): Promise<ChatMessageResponseDto> {
    const {
      sessionId,
      content,
      route,
      normalizedQuery,
      routeTrace,
      ragflowContext,
      contextReferences,
    } = params;
    const provenance = this.buildAnswerProvenance({
      route,
      ragflowContext,
      contextReferences,
    });
    const sourceDiagnostics = this.buildSourceDiagnostics(contextReferences);

    return this.addAssistantMessage(
      sessionId,
      content,
      {
        ...(ragflowContext ?? {}),
        ...provenance,
        answerRoute: route,
        normalizedQuery,
        ...(sourceDiagnostics ? { sourceDiagnostics } : {}),
        ...(routeTrace?.length ? { routeTrace } : {}),
      },
      contextReferences,
    );
  }

  private buildAnswerProvenance(params: {
    route: ChatAnswerRoute;
    ragflowContext?: Record<string, unknown>;
    contextReferences?: ChatCitation[];
  }): {
    usedLlm: boolean;
    usedDocumentation: boolean;
    usedCurrentTelemetry: boolean;
    usedHistoricalTelemetry: boolean;
  } {
    const { route, ragflowContext, contextReferences } = params;
    const clarificationDomain =
      ragflowContext?.clarificationDomain === 'documentation' ||
      ragflowContext?.clarificationDomain === 'current_telemetry' ||
      ragflowContext?.clarificationDomain === 'historical_telemetry'
        ? ragflowContext.clarificationDomain
        : null;
    const explicitUsedLlm =
      typeof ragflowContext?.usedLlm === 'boolean'
        ? ragflowContext.usedLlm
        : undefined;
    const explicitUsedDocumentation =
      typeof ragflowContext?.usedDocumentation === 'boolean'
        ? ragflowContext.usedDocumentation
        : undefined;
    const explicitUsedCurrentTelemetry =
      typeof ragflowContext?.usedCurrentTelemetry === 'boolean'
        ? ragflowContext.usedCurrentTelemetry
        : undefined;
    const explicitUsedHistoricalTelemetry =
      typeof ragflowContext?.usedHistoricalTelemetry === 'boolean'
        ? ragflowContext.usedHistoricalTelemetry
        : undefined;
    const hasDocumentationEvidence = (contextReferences?.length ?? 0) > 0;

    return {
      usedLlm: explicitUsedLlm ?? route === 'llm_generation',
      usedDocumentation:
        explicitUsedDocumentation ??
        (route === 'deterministic_document' ||
          route === 'deterministic_contact' ||
          route === 'deterministic_certificate' ||
          clarificationDomain === 'documentation' ||
          hasDocumentationEvidence),
      usedCurrentTelemetry:
        explicitUsedCurrentTelemetry ??
        (route === 'current_telemetry' ||
          clarificationDomain === 'current_telemetry'),
      usedHistoricalTelemetry:
        explicitUsedHistoricalTelemetry ??
        (route === 'historical_telemetry' ||
          clarificationDomain === 'historical_telemetry' ||
          ragflowContext?.historicalTelemetry === true),
    };
  }

  private buildSourceDiagnostics(contextReferences?: ChatCitation[]):
    | {
        totalReferences: number;
        distinctSourceCount: number;
        effectiveCategories: string[];
        ragflowMetadataCategories: string[];
        mismatchSourceCount: number;
        sources: Array<{
          sourceTitle: string;
          shipManualId?: string;
          effectiveSourceCategory?: string;
          ragflowMetadataCategory?: string;
          ragflowMetadataCategoryLabel?: string;
          categoryAlignment:
            | 'matched'
            | 'mismatch'
            | 'metadata_missing'
            | 'source_missing'
            | 'unknown';
          pageNumbers: number[];
          referenceCount: number;
        }>;
      }
    | undefined {
    if (!contextReferences?.length) {
      return undefined;
    }

    const groupedSources = new Map<
      string,
      {
        sourceTitle: string;
        shipManualId?: string;
        effectiveSourceCategory?: string;
        ragflowMetadataCategory?: string;
        ragflowMetadataCategoryLabel?: string;
        pageNumbers: Set<number>;
        referenceCount: number;
      }
    >();

    for (const reference of contextReferences) {
      const sourceTitle =
        this.normalizeDiagnosticText(reference.sourceTitle) ?? 'Document';
      const shipManualId = this.normalizeDiagnosticText(reference.shipManualId);
      const effectiveSourceCategory = this.normalizeDiagnosticCategory(
        reference.sourceCategory,
      );
      const ragflowMetadataCategory = this.normalizeDiagnosticCategory(
        reference.sourceMetadataCategory,
      );
      const ragflowMetadataCategoryLabel = this.normalizeDiagnosticText(
        reference.sourceMetadataCategoryLabel,
      );
      const key = `${shipManualId ?? ''}::${sourceTitle}`;
      const existing = groupedSources.get(key) ?? {
        sourceTitle,
        shipManualId,
        effectiveSourceCategory,
        ragflowMetadataCategory,
        ragflowMetadataCategoryLabel,
        pageNumbers: new Set<number>(),
        referenceCount: 0,
      };

      if (!existing.effectiveSourceCategory && effectiveSourceCategory) {
        existing.effectiveSourceCategory = effectiveSourceCategory;
      }
      if (!existing.ragflowMetadataCategory && ragflowMetadataCategory) {
        existing.ragflowMetadataCategory = ragflowMetadataCategory;
      }
      if (
        !existing.ragflowMetadataCategoryLabel &&
        ragflowMetadataCategoryLabel
      ) {
        existing.ragflowMetadataCategoryLabel = ragflowMetadataCategoryLabel;
      }
      if (
        typeof reference.pageNumber === 'number' &&
        Number.isFinite(reference.pageNumber)
      ) {
        existing.pageNumbers.add(reference.pageNumber);
      }
      existing.referenceCount += 1;
      groupedSources.set(key, existing);
    }

    const sources = Array.from(groupedSources.values())
      .map((source) => {
        const categoryAlignment = this.getSourceCategoryAlignment(source);
        return {
          sourceTitle: source.sourceTitle,
          ...(source.shipManualId ? { shipManualId: source.shipManualId } : {}),
          ...(source.effectiveSourceCategory
            ? { effectiveSourceCategory: source.effectiveSourceCategory }
            : {}),
          ...(source.ragflowMetadataCategory
            ? { ragflowMetadataCategory: source.ragflowMetadataCategory }
            : {}),
          ...(source.ragflowMetadataCategoryLabel
            ? {
                ragflowMetadataCategoryLabel:
                  source.ragflowMetadataCategoryLabel,
              }
            : {}),
          categoryAlignment,
          pageNumbers: Array.from(source.pageNumbers).sort(
            (left, right) => left - right,
          ),
          referenceCount: source.referenceCount,
        };
      })
      .sort((left, right) => left.sourceTitle.localeCompare(right.sourceTitle));

    return {
      totalReferences: contextReferences.length,
      distinctSourceCount: sources.length,
      effectiveCategories: this.collectUniqueDiagnosticValues(
        sources.map((source) => source.effectiveSourceCategory),
      ),
      ragflowMetadataCategories: this.collectUniqueDiagnosticValues(
        sources.map((source) => source.ragflowMetadataCategory),
      ),
      mismatchSourceCount: sources.filter(
        (source) => source.categoryAlignment === 'mismatch',
      ).length,
      sources,
    };
  }

  private getSourceCategoryAlignment(source: {
    effectiveSourceCategory?: string;
    ragflowMetadataCategory?: string;
  }):
    | 'matched'
    | 'mismatch'
    | 'metadata_missing'
    | 'source_missing'
    | 'unknown' {
    if (source.effectiveSourceCategory && source.ragflowMetadataCategory) {
      return source.effectiveSourceCategory === source.ragflowMetadataCategory
        ? 'matched'
        : 'mismatch';
    }

    if (source.effectiveSourceCategory) {
      return 'metadata_missing';
    }

    if (source.ragflowMetadataCategory) {
      return 'source_missing';
    }

    return 'unknown';
  }

  private collectUniqueDiagnosticValues(
    values: Array<string | undefined>,
  ): string[] {
    return Array.from(
      new Set(values.filter((value): value is string => Boolean(value))),
    ).sort((left, right) => left.localeCompare(right));
  }

  private normalizeDiagnosticCategory(value?: string): string | undefined {
    const normalized = this.normalizeDiagnosticText(value)?.toUpperCase();
    return normalized?.length ? normalized : undefined;
  }

  private normalizeDiagnosticText(value?: string): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  }

  private getCarriedForwardDocumentationCitations(params: {
    userQuery: string;
    normalizedQuery: ChatNormalizedQuery;
    previousUserQuery?: string;
    messageHistory?: ChatHistoryMessage[];
    sourceLockActive?: boolean;
    lockedManualId?: string | null;
  }): ChatCitation[] {
    const {
      userQuery,
      normalizedQuery,
      previousUserQuery,
      messageHistory,
      sourceLockActive,
      lockedManualId,
    } = params;
    if (!messageHistory?.length) {
      return [];
    }

    const canCarryLockedSourceCitations =
      sourceLockActive &&
      this.shouldCarryForwardLockedDocumentationCitations(userQuery);
    if (canCarryLockedSourceCitations) {
      const carried = this.findRecentLockedDocumentationCitations(
        messageHistory,
        lockedManualId,
      );
      if (carried.length > 0) {
        return carried;
      }
    }

    if (
      normalizedQuery.followUpMode !== 'follow_up' ||
      !this.isPersonnelDetailFollowUpQuery(userQuery)
    ) {
      return [];
    }

    const priorSubject = (
      previousUserQuery ??
      normalizedQuery.previousUserQuery ??
      ''
    ).trim();
    if (
      !priorSubject ||
      !this.looksLikePersonnelDirectorySubject(priorSubject)
    ) {
      return [];
    }

    for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
      const message = messageHistory[index];
      if (message.role !== 'assistant') {
        continue;
      }

      const references = message.contextReferences ?? [];
      if (references.length === 0) {
        continue;
      }

      const context =
        message.ragflowContext && typeof message.ragflowContext === 'object'
          ? (message.ragflowContext as Record<string, unknown>)
          : null;
      if (context?.usedDocumentation !== true) {
        continue;
      }

      const answerRoute =
        typeof context?.answerRoute === 'string'
          ? context.answerRoute.trim()
          : '';
      const priorNormalizedQuery =
        context?.normalizedQuery && typeof context.normalizedQuery === 'object'
          ? (context.normalizedQuery as Record<string, unknown>)
          : null;
      const priorFollowUpMode =
        typeof priorNormalizedQuery?.followUpMode === 'string'
          ? priorNormalizedQuery.followUpMode.trim()
          : '';
      if (
        answerRoute !== 'deterministic_contact' &&
        priorFollowUpMode !== 'follow_up'
      ) {
        continue;
      }

      return this.dedupeChatCitations(references);
    }

    return [];
  }

  private shouldCarryForwardLockedDocumentationCitations(
    userQuery: string,
  ): boolean {
    const trimmed = userQuery.trim();
    if (!trimmed) {
      return false;
    }

    if (/\b(?:page|p\.?)\s*#?\s*\d{1,4}\b/i.test(trimmed)) {
      return false;
    }

    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    if (wordCount > 12) {
      return false;
    }

    return (
      /\b(it|its|that|this|they|them|their|those|these|same|one)\b/i.test(
        trimmed,
      ) ||
      /\b(parts?|spares?|items?|components?|quantit(?:y|ies)|qty|pages?|sources?|steps?|procedures?|records?|checks?|warnings?|requirements?|limits?|tools?|materials?)\b/i.test(
        trimmed,
      )
    );
  }

  private findRecentLockedDocumentationCitations(
    messageHistory: ChatHistoryMessage[],
    lockedManualId?: string | null,
  ): ChatCitation[] {
    const normalizedLockedManualId = lockedManualId?.trim();

    for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
      const message = messageHistory[index];
      if (message.role !== 'assistant') {
        continue;
      }

      const context =
        message.ragflowContext && typeof message.ragflowContext === 'object'
          ? (message.ragflowContext as Record<string, unknown>)
          : null;
      if (context?.usedDocumentation !== true) {
        continue;
      }

      const references = message.contextReferences ?? [];
      if (references.length === 0) {
        continue;
      }

      const contextualManualId =
        normalizedLockedManualId ??
        this.extractLockedManualIdFromRagflowContext(context);
      const sourceScopedReferences = contextualManualId
        ? references.filter(
            (reference) => reference.shipManualId === contextualManualId,
          )
        : references;
      if (sourceScopedReferences.length === 0) {
        continue;
      }

      const manualIds = [
        ...new Set(
          sourceScopedReferences
            .map((reference) => reference.shipManualId)
            .filter((manualId): manualId is string => Boolean(manualId)),
        ),
      ];
      if (!contextualManualId && manualIds.length !== 1) {
        continue;
      }

      return this.dedupeChatCitations(sourceScopedReferences);
    }

    return [];
  }

  private extractLockedManualIdFromRagflowContext(
    context: Record<string, unknown> | null,
  ): string | null {
    const followUpState =
      context?.documentationFollowUpState &&
      typeof context.documentationFollowUpState === 'object'
        ? (context.documentationFollowUpState as Record<string, unknown>)
        : null;
    const lockedManualId =
      typeof followUpState?.lockedManualId === 'string'
        ? followUpState.lockedManualId.trim()
        : '';

    return lockedManualId || null;
  }

  private getCarriedForwardSummaryDocumentationCitations(params: {
    userQuery: string;
    normalizedQuery: ChatNormalizedQuery;
    messageHistory?: ChatHistoryMessage[];
  }): ChatCitation[] {
    const { userQuery, normalizedQuery, messageHistory } = params;
    if (
      normalizedQuery.followUpMode !== 'follow_up' ||
      !this.documentationQueryService.isSummaryFollowUpQuery(userQuery) ||
      !messageHistory?.length
    ) {
      return [];
    }

    for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
      const message = messageHistory[index];
      if (message.role !== 'assistant') {
        continue;
      }

      const references = message.contextReferences ?? [];
      if (references.length === 0) {
        continue;
      }

      const context =
        message.ragflowContext && typeof message.ragflowContext === 'object'
          ? (message.ragflowContext as Record<string, unknown>)
          : null;
      if (context?.usedDocumentation !== true) {
        continue;
      }

      return this.dedupeChatCitations(references);
    }

    return [];
  }

  private shouldBypassDeterministicContactFollowUp(
    userQuery: string,
    normalizedQuery: ChatNormalizedQuery,
    carriedForwardDocumentationCitations: ChatCitation[],
  ): boolean {
    if (
      normalizedQuery.followUpMode !== 'follow_up' ||
      carriedForwardDocumentationCitations.length === 0
    ) {
      return false;
    }

    const trimmed = userQuery.trim();
    return (
      /^(?:(?:only)\s+)?(?:the\s+)?(?:email|emails|phone|telephone|mobile|number|numbers|address|role|roles|position|positions|title|titles)(?:\s+only)?[!.?]*$/i.test(
        trimmed,
      ) ||
      /\b(?:other|another|same)\s+one\b/i.test(trimmed) ||
      /\bwhat\s+about\s+(?:the\s+)?(?:other|another|same)\b/i.test(trimmed)
    );
  }

  private isPersonnelDetailFollowUpQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed) {
      return false;
    }

    return (
      /^(?:(?:only)\s+)?(?:the\s+)?(?:contact|contacts|contact\s+details?|details?|email|emails|phone|telephone|mobile|number|numbers|address|role|roles|position|positions|title|titles)(?:\s+only)?[!.?]*$/i.test(
        trimmed,
      ) ||
      /\b(?:other|another|same)\s+one\b/i.test(trimmed) ||
      /\bwhat\s+about\s+(?:the\s+)?(?:other|another|same)\b/i.test(trimmed)
    );
  }

  private looksLikePersonnelDirectorySubject(value: string): boolean {
    return (
      this.documentationQueryService.isPersonnelDirectoryQuery(value) ||
      /\b(contact|contacts|email|emails|phone|telephone|mobile|number|numbers|address|role|roles|position|positions|title|titles|dpa|cso|manager|director|officer|engineer|captain|master)\b/i.test(
        value,
      )
    );
  }

  private dedupeChatCitations(citations: ChatCitation[]): ChatCitation[] {
    const seen = new Set<string>();
    const deduped: ChatCitation[] = [];

    for (const citation of citations) {
      const key = [
        citation.shipManualId ?? '',
        citation.chunkId ?? '',
        citation.pageNumber ?? '',
        citation.sourceTitle ?? '',
        citation.snippet ?? '',
      ].join('|');
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(citation);
    }

    return deduped;
  }

  private buildStructuredConversationState(
    messageHistory?: Array<{
      role: string;
      content: string;
      ragflowContext?: unknown;
    }>,
  ): string | undefined {
    if (!messageHistory?.length) {
      return undefined;
    }

    const assistantStateLines = messageHistory
      .filter((message) => message.role === 'assistant')
      .map((message) =>
        this.summarizeAssistantConversationState(message.ragflowContext),
      )
      .filter((line): line is string => Boolean(line))
      .slice(-3);
    const activeClarification =
      this.documentationQueryService.getPendingClarificationState(
        messageHistory,
      );
    const lines: string[] = [];

    if (assistantStateLines.length > 0) {
      lines.push('Recent assistant states:');
      lines.push(...assistantStateLines.map((line) => `- ${line}`));
    }

    if (activeClarification) {
      lines.push(
        `Active clarification: domain=${activeClarification.clarificationDomain}; pendingQuery="${this.truncateForLog(
          activeClarification.pendingQuery,
          80,
        )}"; requiredFields=${
          activeClarification.requiredFields?.join(', ') || 'none'
        }`,
      );
    }

    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  private normalizeGeneratedLlmResponse(
    response: string | LlmGeneratedResponse,
  ): LlmGeneratedResponse {
    if (typeof response === 'string') {
      return { content: response };
    }

    return response;
  }

  private getLatestLlmResponseIdFromRecentAssistant(
    messageHistory?: Array<{
      role: string;
      content: string;
      ragflowContext?: unknown;
    }>,
  ): string | undefined {
    if (!messageHistory?.length) {
      return undefined;
    }

    for (let index = messageHistory.length - 1; index >= 0; index -= 1) {
      const message = messageHistory[index];
      if (message.role !== 'assistant') {
        continue;
      }

      if (
        !message.ragflowContext ||
        typeof message.ragflowContext !== 'object'
      ) {
        return undefined;
      }

      const llmResponseId = (message.ragflowContext as Record<string, unknown>)
        .llmResponseId;
      return typeof llmResponseId === 'string' && llmResponseId.trim()
        ? llmResponseId.trim()
        : undefined;
    }

    return undefined;
  }

  private summarizeAssistantConversationState(
    ragflowContext: unknown,
  ): string | null {
    if (!ragflowContext || typeof ragflowContext !== 'object') {
      return null;
    }

    const context = ragflowContext as Record<string, unknown>;
    const normalizedQuery =
      context.normalizedQuery && typeof context.normalizedQuery === 'object'
        ? (context.normalizedQuery as Record<string, unknown>)
        : null;
    const parts: string[] = [];
    const answerRoute =
      typeof context.answerRoute === 'string' ? context.answerRoute.trim() : '';
    if (answerRoute) {
      parts.push(`answerRoute=${answerRoute}`);
    }

    if (typeof context.usedLlm === 'boolean') {
      parts.push(`generator=${context.usedLlm ? 'llm' : 'deterministic'}`);
    }

    const sourceFlags: string[] = [];
    if (context.usedDocumentation === true) {
      sourceFlags.push('documentation');
    }
    if (context.usedCurrentTelemetry === true) {
      sourceFlags.push('current_telemetry');
    }
    if (context.usedHistoricalTelemetry === true) {
      sourceFlags.push('historical_telemetry');
    }
    if (sourceFlags.length > 0) {
      parts.push(`sources=${sourceFlags.join('+')}`);
    }

    const documentationSemanticQuery =
      context.documentationSemanticQuery &&
      typeof context.documentationSemanticQuery === 'object'
        ? (context.documentationSemanticQuery as Record<string, unknown>)
        : null;
    if (typeof documentationSemanticQuery?.intent === 'string') {
      parts.push(`semanticIntent=${documentationSemanticQuery.intent}`);
    }

    const documentationFollowUpState =
      context.documentationFollowUpState &&
      typeof context.documentationFollowUpState === 'object'
        ? (context.documentationFollowUpState as Record<string, unknown>)
        : null;
    const lockedManualTitle =
      typeof documentationFollowUpState?.lockedManualTitle === 'string'
        ? documentationFollowUpState.lockedManualTitle.trim()
        : '';
    if (lockedManualTitle) {
      parts.push(`sourceLock="${this.truncateForLog(lockedManualTitle, 72)}"`);
    }

    const resolvedSubjectQuery =
      typeof context.resolvedSubjectQuery === 'string'
        ? context.resolvedSubjectQuery.trim()
        : '';
    if (resolvedSubjectQuery) {
      parts.push(
        `resolvedSubject="${this.truncateForLog(resolvedSubjectQuery, 80)}"`,
      );
    }

    const subject =
      typeof normalizedQuery?.subject === 'string'
        ? normalizedQuery.subject.trim()
        : '';
    if (subject) {
      parts.push(`subject="${this.truncateForLog(subject, 48)}"`);
    }

    const followUpMode =
      typeof normalizedQuery?.followUpMode === 'string'
        ? normalizedQuery.followUpMode.trim()
        : '';
    if (followUpMode) {
      parts.push(`followUpMode=${followUpMode}`);
    }

    return parts.length > 0 ? parts.join('; ') : null;
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
    normalizedQuery: ChatNormalizedQuery;
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
      normalizedQuery,
    } = params;

    if (shipId) {
      return {
        resolution: await this.tryResolveHistoricalTelemetryForShip({
          shipId,
          sessionId,
          userQuery,
          effectiveUserQuery,
          resolvedSubjectQuery,
          normalizedQuery,
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
        normalizedQuery,
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
    normalizedQuery: ChatNormalizedQuery;
  }): Promise<
    Awaited<ReturnType<MetricsService['resolveHistoricalTelemetryQuery']>>
  > {
    const {
      shipId,
      sessionId,
      userQuery,
      effectiveUserQuery,
      resolvedSubjectQuery,
      normalizedQuery,
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
          normalizedQuery,
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
        sourceCategory: ref.shipManual?.category ?? undefined,
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
    const candidates = [...existing.actions, ...prefixedActions];

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
    telemetryMatchedMetrics: number,
  ): string | null {
    if (!this.shouldUseDeterministicTelemetryAnswer(queryPlan, userQuery)) {
      return null;
    }

    if (!telemetryPrefiltered) {
      return null;
    }

    if (queryPlan.primaryIntent === 'telemetry_list') {
      if (
        telemetryMatchMode !== 'sample' &&
        telemetryMatchMode !== 'exact' &&
        telemetryMatchMode !== 'direct'
      ) {
        return null;
      }

      return this.buildDeterministicTelemetryListAnswer(telemetry, {
        sampled: telemetryMatchMode === 'sample',
        totalMatchedMetrics: telemetryMatchedMetrics,
      });
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
  ): { content: string; citations?: ChatCitation[] } | null {
    if (citations.length === 0) {
      return null;
    }

    if (primaryIntent === 'manual_specification') {
      const auditChecklistAnswer = this.buildDeterministicAuditChecklistAnswer(
        userQuery,
        citations,
      );
      if (auditChecklistAnswer) {
        return { content: auditChecklistAnswer };
      }

      const tankCapacityAnswer = this.buildDeterministicTankCapacityAnswer(
        userQuery,
        citations,
      );
      if (tankCapacityAnswer) {
        return tankCapacityAnswer;
      }

      const manualSpecificationAnswer =
        this.buildDeterministicManualSpecificationAnswer(userQuery, citations);
      return manualSpecificationAnswer
        ? { content: manualSpecificationAnswer }
        : null;
    }

    return null;
  }

  private buildDeterministicContactLookupAnswer(
    userQuery: string,
    effectiveUserQuery: string,
    citations: ChatCitation[],
  ): { content: string; citations: ChatCitation[] } | null {
    const directoryQuery = effectiveUserQuery.trim() || userQuery.trim();
    if (
      citations.length === 0 ||
      !this.documentationQueryService.isPersonnelDirectoryQuery(directoryQuery)
    ) {
      return null;
    }

    const allEntries = citations.flatMap((citation) =>
      this.extractDeterministicContactEntries(citation),
    );
    if (allEntries.length === 0) {
      return null;
    }

    const dedupedEntries = this.dedupeDeterministicContactEntries(allEntries);

    if (this.documentationQueryService.isRoleInventoryQuery(userQuery)) {
      const roleInventory = this.extractDeterministicRoleInventory(
        dedupedEntries,
      ).slice(0, 12);
      if (roleInventory.length === 0) {
        return null;
      }

      const matchedCitations = [
        ...new Set(roleInventory.map((entry) => entry.citation)),
      ];
      const sourceLabel =
        matchedCitations[0]?.sourceTitle ?? 'the cited contact document';

      return {
        content: [
          'The roles I found in the provided documentation are:',
          '',
          ...roleInventory.map((entry) => `- ${entry.role}`),
          '',
          `These roles are sourced from ${sourceLabel} [Contact: ${sourceLabel}].`,
        ].join('\n'),
        citations: matchedCitations,
      };
    }

    const matchingEntries = this.filterDeterministicContactEntriesForQuery(
      directoryQuery,
      dedupedEntries,
    );
    if (matchingEntries.length === 0) {
      return null;
    }

    const wantsExhaustiveList =
      /\b(list\s+all|all\s+contacts|all\s+managers|all\s+directors|all\s+roles|everyone|everybody)\b/i.test(
        userQuery,
      );
    const sourceScopedEntries = this.preferDeterministicContactSourceEntries(
      directoryQuery,
      matchingEntries,
      wantsExhaustiveList,
    );
    const maxEntries = wantsExhaustiveList ? 12 : 6;
    const selectedEntries = sourceScopedEntries.slice(0, maxEntries);
    const omittedEntriesCount = Math.max(
      0,
      sourceScopedEntries.length - selectedEntries.length,
    );
    const matchedCitations = [
      ...new Set(selectedEntries.map((entry) => entry.citation)),
    ];
    const sourceLabel =
      matchedCitations[0]?.sourceTitle ?? 'the cited contact document';

    if (selectedEntries.length === 1) {
      const [entry] = selectedEntries;
      const details = [entry.name, entry.role, entry.email, entry.phone].filter(
        Boolean,
      );
      const lines = [
        'The contact details I found are:',
        '',
        `- ${details.join(' - ')}`,
      ];

      if (false) {
        lines.push(`- Position: ${entry.role}`);
      }
      if (false) {
        lines.push(`- Mobile: ${entry.phone}`);
      }
      if (false) {
        lines.push(`- Email: ${entry.email}`);
      }

      lines.push(
        '',
        `This information is sourced from ${sourceLabel} [Contact: ${sourceLabel}].`,
      );

      return {
        content: lines.join('\n'),
        citations: matchedCitations,
      };
    }

    return {
      content: [
        'I found multiple contacts that match this request in the provided documentation:',
        '',
        ...selectedEntries.map((entry) => {
          const details = [
            entry.name,
            entry.role,
            entry.phone,
            entry.email,
          ].filter(Boolean);

          return `- ${details.join(' - ')}`;
        }),
        ...(omittedEntriesCount > 0
          ? [
              '',
              `Showing the first ${selectedEntries.length} of ${sourceScopedEntries.length} matching contacts. ${
                omittedEntriesCount === 1
                  ? '1 additional contact is listed'
                  : `${omittedEntriesCount} additional contacts are listed`
              } in the source document.`,
            ]
          : []),
        '',
        `These contacts are sourced from ${sourceLabel} [Contact: ${sourceLabel}].`,
      ].join('\n'),
      citations: matchedCitations,
    };
  }

  private preferDeterministicContactSourceEntries(
    userQuery: string,
    entries: DeterministicContactEntry[],
    wantsExhaustiveList: boolean,
  ): DeterministicContactEntry[] {
    if (entries.length <= 1) {
      return entries;
    }

    const groups = this.groupDeterministicContactEntriesBySource(entries);
    if (groups.length <= 1) {
      return entries;
    }

    const explicitDirectoryRequest =
      /\b(contact\s+details\s+document|company\s+contact|contact\s+sheet|directory|crew\s+list)\b/i.test(
        userQuery,
      );
    const anchorTerms =
      this.documentationQueryService.extractContactAnchorTerms(userQuery);
    const rankedGroups = groups
      .map((group) => ({
        ...group,
        profile: this.buildDeterministicContactSourceProfile(
          group.entries,
          anchorTerms,
        ),
      }))
      .sort(
        (left, right) => right.profile.totalScore - left.profile.totalScore,
      );
    const [bestGroup, secondGroup] = rankedGroups;
    if (!bestGroup) {
      return entries;
    }

    const secondScore =
      secondGroup?.profile.totalScore ?? Number.NEGATIVE_INFINITY;
    const strongLead =
      bestGroup.profile.totalScore >= secondScore + 15 ||
      bestGroup.profile.directoryScore >
        (secondGroup?.profile.directoryScore ?? 0);
    const shouldPreferSingleSource =
      wantsExhaustiveList ||
      explicitDirectoryRequest ||
      bestGroup.profile.directoryScore > 0 ||
      bestGroup.profile.anchorCoverage >
        (secondGroup?.profile.anchorCoverage ?? 0);

    return strongLead && shouldPreferSingleSource ? bestGroup.entries : entries;
  }

  private groupDeterministicContactEntriesBySource(
    entries: DeterministicContactEntry[],
  ): Array<{ sourceKey: string; entries: DeterministicContactEntry[] }> {
    const grouped = new Map<string, DeterministicContactEntry[]>();

    for (const entry of entries) {
      const sourceKey = (entry.citation.sourceTitle ?? '').trim().toLowerCase();
      const bucket = grouped.get(sourceKey) ?? [];
      bucket.push(entry);
      grouped.set(sourceKey, bucket);
    }

    return [...grouped.entries()].map(([sourceKey, groupedEntries]) => ({
      sourceKey,
      entries: groupedEntries,
    }));
  }

  private buildDeterministicContactSourceProfile(
    entries: DeterministicContactEntry[],
    anchorTerms: string[],
  ): {
    totalScore: number;
    directoryScore: number;
    anchorCoverage: number;
  } {
    const sourceTitle = entries[0]?.citation.sourceTitle ?? '';
    const normalizedTitle = sourceTitle.toLowerCase();
    const directoryScore =
      /\b(contact\s+details|company\s+contact|directory|crew\s+list)\b/i.test(
        normalizedTitle,
      )
        ? 4
        : /\b(contact|email|phone)\b/i.test(normalizedTitle)
          ? 2
          : 0;
    const noisePenalty =
      /\b(ntvrp|response|plan|appendix|checklist|procedure|manual|guide|instruction)\b/i.test(
        normalizedTitle,
      )
        ? 3
        : 0;
    const anchorCoverage = anchorTerms.filter((term) =>
      entries.some((entry) =>
        [entry.name, entry.role ?? '', entry.email ?? '', entry.phone ?? '']
          .join('\n')
          .toLowerCase()
          .includes(term),
      ),
    ).length;
    const roleCount = entries.filter((entry) => entry.role).length;
    const contactPointCount = entries.filter(
      (entry) => entry.email || entry.phone,
    ).length;
    const totalScore =
      directoryScore * 30 +
      anchorCoverage * 8 +
      roleCount * 4 +
      contactPointCount * 2 +
      entries.length * 6 -
      noisePenalty * 25;

    return {
      totalScore,
      directoryScore,
      anchorCoverage,
    };
  }

  private extractDeterministicRoleInventory(
    entries: DeterministicContactEntry[],
  ): Array<{ role: string; citation: ChatCitation }> {
    const roles = new Map<string, { role: string; citation: ChatCitation }>();

    for (const entry of entries) {
      const role = entry.role?.trim();
      if (!role) {
        continue;
      }

      const normalizedRole = this.normalizeDeterministicContactText(role)
        .toLowerCase()
        .replace(/\s+/g, ' ');
      const existing = roles.get(normalizedRole);
      if (
        !existing ||
        (entry.citation.score ?? 0) > (existing.citation.score ?? 0)
      ) {
        roles.set(normalizedRole, {
          role,
          citation: entry.citation,
        });
      }
    }

    return [...roles.values()].sort((left, right) =>
      left.role.localeCompare(right.role),
    );
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

    const rawCertificateEntries = citations
      .filter((citation) =>
        this.isDeterministicCertificateExpiryEvidence(citation),
      )
      .flatMap((citation) =>
        this.extractExplicitCertificateExpiries(citation.snippet).map(
          (expiry) => ({
            citation,
            timestamp: expiry.timestamp,
            displayDate: expiry.displayDate,
            sourceLabel: citation.sourceTitle ?? 'the cited certificate',
          }),
        ),
      );
    const dedupedCertificateEntries = new Map<
      string,
      (typeof rawCertificateEntries)[number]
    >();
    for (const entry of rawCertificateEntries) {
      const dedupKey = this.buildCertificateExpiryEntryDedupKey(entry);
      const existing = dedupedCertificateEntries.get(dedupKey);
      if (!existing) {
        dedupedCertificateEntries.set(dedupKey, entry);
        continue;
      }

      const existingScore = existing.citation.score ?? 0;
      const nextScore = entry.citation.score ?? 0;
      if (nextScore > existingScore) {
        dedupedCertificateEntries.set(dedupKey, entry);
        continue;
      }

      if (
        nextScore === existingScore &&
        entry.sourceLabel.length < existing.sourceLabel.length
      ) {
        dedupedCertificateEntries.set(dedupKey, entry);
      }
    }
    const certificateEntries = [...dedupedCertificateEntries.values()].sort(
      (left, right) => {
        if (left.timestamp !== right.timestamp) {
          return left.timestamp - right.timestamp;
        }

        const leftRegistry = this.isOfficialRegistryCertificateCitation(
          left.citation,
        )
          ? 1
          : 0;
        const rightRegistry = this.isOfficialRegistryCertificateCitation(
          right.citation,
        )
          ? 1
          : 0;
        if (leftRegistry !== rightRegistry) {
          return leftRegistry - rightRegistry;
        }

        return (right.citation.score ?? 0) - (left.citation.score ?? 0);
      },
    );
    const preferredCertificateEntries =
      this.preferDeterministicCertificateEntries(certificateEntries);

    if (preferredCertificateEntries.length === 0) {
      const certificateCitations = citations.filter((citation) =>
        this.isDeterministicCertificateExpiryEvidence(citation),
      );
      const fallbackCitations =
        certificateCitations.length > 0
          ? certificateCitations.slice(0, 3)
          : citations.slice(0, 3);

      return {
        content:
          'I could not confirm any upcoming certificate expiries from the provided certificate documents because the retrieved certificate snippets do not include clear expiry dates.',
        citations: fallbackCitations,
      };
    }

    const now = Date.now();
    const upcomingEntries = preferredCertificateEntries.filter(
      (entry) => entry.timestamp >= now,
    );

    if (upcomingEntries.length > 0) {
      const selected = upcomingEntries.slice(0, 5);

      if (selected.length === 1) {
        const [entry] = selected;
        const remaining = this.formatApproximateTimeUntil(entry.timestamp, now);
        const timingText = remaining ? ` in about ${remaining}` : '';

        return {
          content: `The nearest upcoming certificate expiry I found is ${entry.sourceLabel}, which expires on ${entry.displayDate}${timingText} [Certificate: ${entry.sourceLabel}].`,
          citations: [entry.citation],
        };
      }

      return {
        content: [
          'The nearest upcoming certificate expiries I found are:',
          '',
          ...selected.map((entry) => {
            const remaining = this.formatApproximateTimeUntil(
              entry.timestamp,
              now,
            );
            const timingText = remaining ? ` (in about ${remaining})` : '';
            return `- ${entry.sourceLabel}: ${entry.displayDate}${timingText} [Certificate: ${entry.sourceLabel}]`;
          }),
        ].join('\n'),
        citations: [...new Set(selected.map((entry) => entry.citation))],
      };
    }

    const expiredEntries = preferredCertificateEntries
      .filter((entry) => entry.timestamp < now)
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, 3);
    if (expiredEntries.length > 0) {
      return {
        content:
          'I could not confirm any currently valid upcoming certificate expiries from the provided certificate documents. The certificate snippets I found with explicit expiry dates are already expired.',
        citations: expiredEntries.map((entry) => entry.citation),
      };
    }

    return null;
  }

  private extractDeterministicContactEntries(
    citation: ChatCitation,
  ): DeterministicContactEntry[] {
    const snippet = citation.snippet?.trim();
    if (!snippet) {
      return [];
    }

    const normalized = this.normalizeDeterministicContactText(snippet);
    const nameAnchoredEntries = this.extractNameAnchoredContactEntries(
      normalized,
      citation,
    );
    if (nameAnchoredEntries.length > 0) {
      return nameAnchoredEntries;
    }

    return this.extractEmailAnchoredContactEntries(normalized, citation);
  }

  private extractNameAnchoredContactEntries(
    normalized: string,
    citation: ChatCitation,
  ): DeterministicContactEntry[] {
    const anchors = this.extractDeterministicContactAnchors(normalized);
    if (anchors.length === 0) {
      return [];
    }

    return anchors
      .map((anchor, index) => {
        const segment = normalized
          .slice(anchor.index, anchors[index + 1]?.index ?? normalized.length)
          .trim();
        const entry = this.buildDeterministicContactEntry(
          segment,
          anchor.name,
          citation,
        );
        if (!entry) {
          return null;
        }

        return {
          ...entry,
          order: anchor.index,
        };
      })
      .filter(
        (
          entry,
        ): entry is DeterministicContactEntry & {
          order: number;
        } => Boolean(entry),
      )
      .sort((left, right) => left.order - right.order)
      .map(({ order: _order, ...entry }) => entry);
  }

  private extractEmailAnchoredContactEntries(
    normalized: string,
    citation: ChatCitation,
  ): DeterministicContactEntry[] {
    const emailMatches = [
      ...normalized.matchAll(this.getContactEmailPattern()),
    ];
    if (emailMatches.length === 0) {
      return [];
    }

    return emailMatches
      .map((match) => {
        const emailIndex = match.index ?? 0;
        const windowStart = Math.max(0, emailIndex - 180);
        const windowEnd = Math.min(
          normalized.length,
          emailIndex + match[0].length + 180,
        );
        const segment = normalized.slice(windowStart, windowEnd).trim();
        const anchors = this.extractDeterministicContactAnchors(segment);
        const anchor =
          anchors.length > 0 ? anchors[anchors.length - 1] : undefined;
        const name =
          anchor?.name ?? this.extractDeterministicContactName(segment);

        return this.buildDeterministicContactEntry(segment, name, citation);
      })
      .filter((entry): entry is DeterministicContactEntry => Boolean(entry));
  }

  private buildDeterministicContactEntry(
    segment: string,
    name: string | null,
    citation: ChatCitation,
  ): DeterministicContactEntry | null {
    if (!name) {
      return null;
    }

    const email = this.extractDeterministicContactEmail(segment);
    const phone = this.extractDeterministicContactPhone(segment) ?? undefined;
    const role =
      this.extractDeterministicContactRole(segment, name) ?? undefined;

    if (!email && !phone && !role) {
      return null;
    }

    return {
      name,
      role,
      email: email ?? undefined,
      phone,
      citation,
    };
  }

  private extractDeterministicContactAnchors(
    normalized: string,
  ): Array<{ index: number; name: string }> {
    const anchors: Array<{ index: number; name: string }> = [];
    const pattern = this.getContactNameAnchorPattern();
    let lastAcceptedEnd = -1;

    for (const match of normalized.matchAll(pattern)) {
      const name = match[1]?.trim();
      const index = match.index ?? 0;
      if (index < lastAcceptedEnd) {
        continue;
      }
      if (!name || !this.isLikelyDeterministicContactName(name)) {
        continue;
      }

      const existing = anchors[anchors.length - 1];
      if (existing?.index === index && existing.name === name) {
        continue;
      }

      anchors.push({ index, name });
      lastAcceptedEnd = index + name.length + 24;
    }

    return anchors;
  }

  private dedupeDeterministicContactEntries(
    entries: DeterministicContactEntry[],
  ): DeterministicContactEntry[] {
    const deduped = new Map<string, DeterministicContactEntry>();

    for (const entry of entries) {
      const key = this.buildDeterministicContactEntryKey(entry);

      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, entry);
        continue;
      }

      deduped.set(
        key,
        this.selectPreferredDeterministicContactEntry(existing, entry),
      );
    }

    const mergedBySourceAndName = new Map<string, DeterministicContactEntry>();
    for (const entry of deduped.values()) {
      const key = this.buildDeterministicContactSourceScopedNameKey(entry);
      const existing = mergedBySourceAndName.get(key);
      if (!existing) {
        mergedBySourceAndName.set(key, entry);
        continue;
      }

      mergedBySourceAndName.set(
        key,
        this.mergeDeterministicContactEntries(existing, entry),
      );
    }

    return [...mergedBySourceAndName.values()];
  }

  private buildDeterministicContactEntryKey(
    entry: DeterministicContactEntry,
  ): string {
    return [
      this.normalizeDeterministicContactText(entry.name).toLowerCase(),
      entry.email?.toLowerCase() ?? '',
      (entry.phone ?? '').replace(/\D+/g, ''),
    ].join('::');
  }

  private buildDeterministicContactSourceScopedNameKey(
    entry: DeterministicContactEntry,
  ): string {
    return [
      this.normalizeDeterministicContactText(entry.name).toLowerCase(),
      this.normalizeDeterministicContactText(
        entry.citation.sourceTitle ?? '',
      ).toLowerCase(),
    ].join('::');
  }

  private selectPreferredDeterministicContactEntry(
    existing: DeterministicContactEntry,
    next: DeterministicContactEntry,
  ): DeterministicContactEntry {
    const existingCompleteness =
      this.getDeterministicContactEntryCompleteness(existing);
    const nextCompleteness =
      this.getDeterministicContactEntryCompleteness(next);
    if (nextCompleteness !== existingCompleteness) {
      return nextCompleteness > existingCompleteness ? next : existing;
    }

    const existingScore = existing.citation.score ?? 0;
    const nextScore = next.citation.score ?? 0;
    if (nextScore !== existingScore) {
      return nextScore > existingScore ? next : existing;
    }

    return this.getDeterministicContactEntryTextLength(next) >
      this.getDeterministicContactEntryTextLength(existing)
      ? next
      : existing;
  }

  private mergeDeterministicContactEntries(
    left: DeterministicContactEntry,
    right: DeterministicContactEntry,
  ): DeterministicContactEntry {
    const primary = this.selectPreferredDeterministicContactEntry(left, right);
    const secondary = primary === left ? right : left;

    return {
      name:
        primary.name.length >= secondary.name.length
          ? primary.name
          : secondary.name,
      role: this.choosePreferredDeterministicContactField(
        primary.role,
        secondary.role,
      ),
      email: this.choosePreferredDeterministicContactField(
        primary.email,
        secondary.email,
      ),
      phone: this.choosePreferredDeterministicContactField(
        primary.phone,
        secondary.phone,
      ),
      citation:
        (primary.citation.score ?? 0) >= (secondary.citation.score ?? 0)
          ? primary.citation
          : secondary.citation,
    };
  }

  private choosePreferredDeterministicContactField(
    primary?: string,
    secondary?: string,
  ): string | undefined {
    if (!primary) {
      return secondary ?? undefined;
    }
    if (!secondary) {
      return primary;
    }

    return secondary.length > primary.length ? secondary : primary;
  }

  private getDeterministicContactEntryCompleteness(
    entry: DeterministicContactEntry,
  ): number {
    let score = 0;
    if (entry.role) {
      score += 2;
    }
    if (entry.email) {
      score += 3;
    }
    if (entry.phone) {
      score += 3;
    }

    return score;
  }

  private getDeterministicContactEntryTextLength(
    entry: DeterministicContactEntry,
  ): number {
    return [
      entry.name,
      entry.role ?? '',
      entry.email ?? '',
      entry.phone ?? '',
    ].join(' ').length;
  }

  private filterDeterministicContactEntriesForQuery(
    userQuery: string,
    entries: DeterministicContactEntry[],
  ): DeterministicContactEntry[] {
    const anchorTerms =
      this.documentationQueryService.extractContactAnchorTerms(userQuery);
    const wantsEmail = /\bemails?\b/.test(userQuery.toLowerCase());
    const wantsPhone = /\b(phone|telephone|mobile|number|numbers)\b/i.test(
      userQuery,
    );

    const matched = entries.filter((entry) => {
      const haystack = [
        entry.name,
        entry.role ?? '',
        entry.email ?? '',
        entry.phone ?? '',
      ]
        .join('\n')
        .toLowerCase();

      if (wantsEmail && !entry.email) {
        return false;
      }
      if (wantsPhone && !entry.phone) {
        return false;
      }
      if (anchorTerms.length === 0) {
        return true;
      }

      return anchorTerms.every((term) => haystack.includes(term));
    });

    if (matched.length > 0) {
      return matched.sort((left, right) => {
        const leftRoleMatch =
          anchorTerms.length > 0 &&
          anchorTerms.every((term) =>
            (left.role ?? '').toLowerCase().includes(term),
          )
            ? 1
            : 0;
        const rightRoleMatch =
          anchorTerms.length > 0 &&
          anchorTerms.every((term) =>
            (right.role ?? '').toLowerCase().includes(term),
          )
            ? 1
            : 0;
        if (leftRoleMatch !== rightRoleMatch) {
          return rightRoleMatch - leftRoleMatch;
        }

        return (right.citation.score ?? 0) - (left.citation.score ?? 0);
      });
    }

    return [];
  }

  private normalizeDeterministicContactText(value: string): string {
    return value
      .replace(/<[^>]+>/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[–—−]/g, '-')
      .replace(/[’]/g, "'")
      .replace(/\s*@\s*/g, '@')
      .replace(/\s*\.\s*/g, '.')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractDeterministicContactName(segment: string): string | null {
    const anchor = this.extractDeterministicContactAnchors(segment)[0];
    if (anchor?.name) {
      return anchor.name;
    }

    const nameWithLocationMatch = segment.match(
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*[-–]\s*[A-Z][A-Za-z.\s]{2,40}\b/,
    );
    if (nameWithLocationMatch?.[1]) {
      return nameWithLocationMatch[1].trim();
    }

    const fallbackMatch = segment.match(
      /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/,
    );
    return fallbackMatch?.[1]?.trim() ?? null;
  }

  private extractDeterministicContactRole(
    segment: string,
    name: string,
  ): string | null {
    const cleaned = this.normalizeDeterministicContactText(
      segment
        .replace(this.getContactEmailPattern(), ' ')
        .replace(/\+\s*\d[\d\s()./-]{5,}\d\b/g, ' ')
        .replace(
          new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
          ' ',
        )
        .replace(/\(\s*(?:m|o|work m|personal m)\s*\)/gi, ' '),
    );
    const keywordMatch = cleaned.match(
      /\b(?:Compliance|Founder|Director|Manager|Captain|Master|DPA|CSO)\b/i,
    );
    if (!keywordMatch || keywordMatch.index === undefined) {
      return null;
    }

    let startIndex = keywordMatch.index;
    const prefix = cleaned.slice(0, startIndex);
    const precedingTokenMatch = prefix.match(/([A-Z][A-Za-z/&]+,?)\s*$/);
    if (precedingTokenMatch) {
      startIndex = prefix.lastIndexOf(precedingTokenMatch[1]);
    }

    const role = cleaned
      .slice(startIndex)
      .replace(/^[-,\s]+/, '')
      .replace(/\s+/g, ' ')
      .trim();

    const sanitizedRole = this.sanitizeDeterministicContactRole(role);

    return sanitizedRole || null;
  }

  private sanitizeDeterministicContactRole(role: string): string | null {
    let sanitized = role;
    const sectionMarkers = [
      /\bJMs?\s+Yachting\s+Company\s+Contact\s+Details\b/i,
      /\bGlobalHSQE\b/i,
      /\bOps\s+Team\s*\d+\b/i,
      /\bWebsite\s*\/?\s*I[t1]\b/i,
    ];

    for (const marker of sectionMarkers) {
      const match = sanitized.match(marker);
      if (!match || match.index === undefined || match.index === 0) {
        continue;
      }

      sanitized = sanitized.slice(0, match.index).trim();
    }

    sanitized = sanitized
      .replace(/\s+/g, ' ')
      .replace(/^[-,\s]+|[-,\s]+$/g, '');

    return sanitized || null;
  }

  private extractDeterministicContactPhone(segment: string): string | null {
    const match = segment.match(/\+\s*\d[\d\s()./-]{5,}\d\b/);
    return match?.[0]?.replace(/\s+/g, ' ').trim() ?? null;
  }

  private extractDeterministicContactEmail(segment: string): string | null {
    const match = segment.match(this.getContactEmailPattern());
    return match?.[0] ? this.normalizeContactEmail(match[0]) : null;
  }

  private isLikelyDeterministicContactName(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    const forbiddenTerms = [
      'company',
      'contact',
      'details',
      'yachting',
      'ops',
      'team',
      'website',
      'careers',
      'head',
      'globalhsqe',
      'founder',
      'director',
      'manager',
    ];

    return !forbiddenTerms.some((term) => normalized.includes(term));
  }

  private normalizeContactEmail(value: string): string {
    return value.replace(/\s+/g, '').trim();
  }

  private getContactNameAnchorPattern(): RegExp {
    return /(?=([A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,2})\s*-\s*[A-Z][A-Za-z'.,&]+(?:[\s,]+[A-Z][A-Za-z'.,&]+){0,3})/g;
  }

  private getContactEmailPattern(): RegExp {
    return /\b[a-z0-9._%+-]+\s*@\s*[a-z0-9.-]+\s*\.\s*[a-z]{2,}\b/gi;
  }

  private isDeterministicCertificateExpiryEvidence(
    citation: ChatCitation,
  ): boolean {
    const title = citation.sourceTitle ?? '';
    const haystack = `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`;
    const manualLikeTitle =
      /\b(manual|guide|guidelines|handbook|instruction|user'?s\s+guide|operator|operators)\b/i.test(
        title,
      );
    const supportDocTitle =
      /\b(guideline|guidelines|report|record|records|checklist|history|details|administration|form|list)\b/i.test(
        title,
      );
    const strongTitleSignal =
      /\b(certificate|certificato|approval|license|licence|declaration|registry|renewal|cor\b|class\b)\b/i.test(
        title,
      ) ||
      (/\bsurvey\b/i.test(title) && !supportDocTitle);
    const strongSnippetSignal =
      /\b(this\s+certificate|certificate\s+no\.?|certificateof|certificate\s+of|ec\s+type-?examination|type\s+approval|product\s+design\s+assessment|manufacturing\s+assessment|declaration\s+of\s+conformity|radio\s+station\s+communication\s+license|valid\s+until|expiration\s+date|expiry\s+date|expires?\s+on|expiring:)\b/i.test(
        haystack,
      );
    const embeddedApprovalSignal =
      manualLikeTitle &&
      /\b(product\s+design\s+assessment|manufacturing\s+assessment|type\s+approval|declaration\s+of\s+conformity|module\s+[a-z])\b/i.test(
        haystack,
      );

    if (manualLikeTitle && !embeddedApprovalSignal) {
      return false;
    }

    const explicitCategory = citation.sourceCategory?.trim().toUpperCase();
    if (explicitCategory === 'CERTIFICATES') {
      return (
        strongSnippetSignal ||
        (strongTitleSignal && !supportDocTitle) ||
        embeddedApprovalSignal
      );
    }

    return (
      strongSnippetSignal ||
      (strongTitleSignal && !supportDocTitle) ||
      embeddedApprovalSignal
    );
  }

  private preferDeterministicCertificateEntries(
    entries: Array<{
      citation: ChatCitation;
      timestamp: number;
      displayDate: string;
      sourceLabel: string;
    }>,
  ): Array<{
    citation: ChatCitation;
    timestamp: number;
    displayDate: string;
    sourceLabel: string;
  }> {
    const standaloneEntries = entries.filter((entry) =>
      this.isStandaloneDeterministicCertificateCitation(entry.citation),
    );
    if (standaloneEntries.length > 0) {
      return standaloneEntries;
    }

    const embeddedManualEntries = entries.filter((entry) =>
      this.isEmbeddedManualApprovalCertificateCitation(entry.citation),
    );
    if (embeddedManualEntries.length > 0) {
      return embeddedManualEntries;
    }

    return entries;
  }

  private isStandaloneDeterministicCertificateCitation(
    citation: ChatCitation,
  ): boolean {
    const title = citation.sourceTitle ?? '';
    const manualLikeTitle =
      /\b(manual|guide|guidelines|handbook|instruction|user'?s\s+guide|operator|operators)\b/i.test(
        title,
      );

    return (
      this.isDeterministicCertificateExpiryEvidence(citation) &&
      !manualLikeTitle
    );
  }

  private isEmbeddedManualApprovalCertificateCitation(
    citation: ChatCitation,
  ): boolean {
    const title = citation.sourceTitle ?? '';
    const haystack = `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`;
    const manualLikeTitle =
      /\b(manual|guide|guidelines|handbook|instruction|user'?s\s+guide|operator|operators)\b/i.test(
        title,
      );

    return (
      manualLikeTitle &&
      /\b(product\s+design\s+assessment|manufacturing\s+assessment|type\s+approval|declaration\s+of\s+conformity|module\s+[a-z])\b/i.test(
        haystack,
      )
    );
  }

  private buildCertificateExpiryEntryDedupKey(entry: {
    citation: ChatCitation;
    timestamp: number;
    sourceLabel: string;
  }): string {
    if (this.isOfficialRegistryCertificateCitation(entry.citation)) {
      return `registry::${entry.timestamp}`;
    }

    return `${entry.sourceLabel.trim().toLowerCase()}::${entry.timestamp}`;
  }

  private isOfficialRegistryCertificateCitation(
    citation: ChatCitation,
  ): boolean {
    const haystack =
      `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
    return /\b(certificate\s+of\s+registry|official\s+and\s+imo|name\s+of\s+ship|issued\s+in\s+terms|renew(?:ing|al)\s+certificate|registrar\s+of\s+maltese\s+ships)\b/i.test(
      haystack,
    );
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

    const historyBasisQuery =
      this.buildFuelForecastHistoricalBasisQuery(userQuery);
    const historicalBasisNormalizedQuery =
      this.queryNormalizationService.normalizeTurn({
        userQuery: historyBasisQuery,
      });
    const historicalMatch = await this.resolveHistoricalTelemetryForContext({
      shipId,
      role,
      sessionId,
      userQuery: historyBasisQuery,
      effectiveUserQuery: historyBasisQuery,
      resolvedSubjectQuery: historyBasisQuery,
      normalizedQuery: historicalBasisNormalizedQuery,
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
    const basisLabel = this.describeFuelForecastBasis(
      userQuery,
      historyBasisQuery,
    );
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
      /\b(certificates?|certifications?)\b/.test(normalized) &&
      /\b(expire|expiry|expiries|expiring|valid\s+until|due\s+to\s+expire)\b/.test(
        normalized,
      ) &&
      /\b(soon|upcoming|next|nearest)\b/.test(normalized)
    );
  }

  private extractExplicitCertificateExpiry(
    snippet?: string,
  ): { timestamp: number; displayDate: string } | null {
    return this.extractExplicitCertificateExpiries(snippet)[0] ?? null;
  }

  private extractExplicitCertificateExpiries(
    snippet?: string,
  ): Array<{ timestamp: number; displayDate: string }> {
    if (!snippet) {
      return [];
    }

    const plainText = snippet
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const patterns = [
      /\b(?:valid\s+until|expiry(?:\s+date)?|expiration(?:\s+date)?|expiring|expires?\s+on|expire\s+on|will\s+expire\s+on|scadenza(?:\s*\/\s*expiring)?|expiring:)\b[^0-9a-z]{0,20}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{1,2}(?:st|nd|rd|th)?(?:\s+|[-/])[a-z]{3,9}(?:\s+|[-/])\d{2,4})\b/gi,
    ];
    const seen = new Set<number>();
    const expiries: Array<{ timestamp: number; displayDate: string }> = [];

    for (const pattern of patterns) {
      for (const match of plainText.matchAll(pattern)) {
        if (!match?.[1]) {
          continue;
        }

        const parsedDate = this.parseExplicitCertificateDateToken(match[1]);
        if (!parsedDate || seen.has(parsedDate)) {
          continue;
        }

        seen.add(parsedDate);
        expiries.push({
          timestamp: parsedDate,
          displayDate: this.formatExplicitCertificateDate(parsedDate),
        });
      }
    }

    return expiries.sort((left, right) => left.timestamp - right.timestamp);
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

    const numericMatch = normalized.match(
      /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/,
    );
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
      /^(\d{1,2})(?:st|nd|rd|th)?(?:\s+|[-/])([a-z]{3,9})(?:\s+|[-/])(\d{2,4})$/i,
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

  private formatApproximateTimeUntil(
    timestamp: number,
    nowTimestamp: number,
  ): string | null {
    if (timestamp <= nowTimestamp) {
      return null;
    }

    const now = new Date(nowTimestamp);
    const target = new Date(timestamp);
    const totalMonths = Math.max(
      0,
      (target.getUTCFullYear() - now.getUTCFullYear()) * 12 +
        (target.getUTCMonth() - now.getUTCMonth()),
    );
    const years = Math.floor(totalMonths / 12);
    const months = totalMonths % 12;

    const parts: string[] = [];
    if (years > 0) {
      parts.push(`${years} year${years === 1 ? '' : 's'}`);
    }
    if (months > 0) {
      parts.push(`${months} month${months === 1 ? '' : 's'}`);
    }

    if (parts.length > 0) {
      return parts.slice(0, 2).join(' and ');
    }

    const diffDays = Math.max(
      1,
      Math.round((timestamp - nowTimestamp) / (24 * 60 * 60 * 1000)),
    );
    if (diffDays >= 7) {
      const weeks = Math.round(diffDays / 7);
      return `${weeks} week${weeks === 1 ? '' : 's'}`;
    }

    return `${diffDays} day${diffDays === 1 ? '' : 's'}`;
  }

  private buildDeterministicTelemetryUnavailableAnswer(
    userQuery: string,
    primaryIntent: string,
    telemetryPrefiltered: boolean,
    telemetryMatchMode: TelemetryMatchMode,
    telemetryMatchedMetrics: number,
    telemetryOnlyQuery: boolean,
    citations: ChatCitation[],
  ): { content: string; citations: ChatCitation[] } | null {
    if (
      !telemetryOnlyQuery &&
      primaryIntent !== 'telemetry_status' &&
      primaryIntent !== 'telemetry_list'
    ) {
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

    if (primaryIntent === 'telemetry_list') {
      return {
        content:
          telemetryMatchedMetrics > 0
            ? `I found ${telemetryMatchedMetrics} matched telemetry metrics, but their current values are unavailable.`
            : "I couldn't find matched telemetry metrics for this request.",
        citations: [],
      };
    }

    if (telemetryOnlyQuery && primaryIntent !== 'telemetry_status') {
      return {
        content:
          "I couldn't determine the requested answer from direct matched telemetry data.",
        citations: [],
      };
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
        const range = this.extractPreferredDocumentedRangeText(
          citation.snippet,
        );
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

  private buildDeterministicTankCapacityAnswer(
    userQuery: string,
    citations: ChatCitation[],
  ): { content: string; citations: ChatCitation[] } | null {
    if (!this.documentationQueryService.isTankCapacityLookupQuery(userQuery)) {
      return null;
    }

    const entries = this.dedupeDeterministicTankCapacityEntries(
      citations.flatMap((citation) =>
        this.extractDeterministicTankCapacityEntries(citation, userQuery),
      ),
    );
    if (entries.length === 0) {
      return null;
    }

    const sourceScopedEntries =
      this.preferDeterministicTankCapacitySourceEntries(entries);
    const selectedEntries = sourceScopedEntries.slice(0, 12);
    const omittedEntriesCount = Math.max(
      0,
      sourceScopedEntries.length - selectedEntries.length,
    );
    const matchedCitations = [
      ...new Set(selectedEntries.map((entry) => entry.citation)),
    ];
    const sourceLabel =
      matchedCitations[0]?.sourceTitle ?? 'the cited tank table';

    return {
      content: [
        'The tank capacities I found in the provided documentation are:',
        '',
        ...selectedEntries.map(
          (entry) => `- ${entry.label}: ${entry.capacity}`,
        ),
        ...(omittedEntriesCount > 0
          ? [
              '',
              `Showing the first ${selectedEntries.length} of ${sourceScopedEntries.length} matching tank-capacity rows from the source documentation.`,
            ]
          : []),
        '',
        `These capacities are sourced from ${sourceLabel} [Manual: ${sourceLabel}].`,
      ].join('\n'),
      citations: matchedCitations,
    };
  }

  private preferDeterministicTankCapacitySourceEntries(
    entries: DeterministicTankCapacityEntry[],
  ): DeterministicTankCapacityEntry[] {
    if (entries.length <= 1) {
      return entries;
    }

    const grouped = new Map<string, DeterministicTankCapacityEntry[]>();
    for (const entry of entries) {
      const sourceKey = (entry.citation.sourceTitle ?? '').trim().toLowerCase();
      const bucket = grouped.get(sourceKey) ?? [];
      bucket.push(entry);
      grouped.set(sourceKey, bucket);
    }

    if (grouped.size <= 1) {
      return entries;
    }

    const rankedGroups = [...grouped.values()]
      .map((groupEntries) => ({
        entries: groupEntries,
        entryCount: groupEntries.length,
        totalScore: groupEntries.reduce(
          (sum, entry) => sum + (entry.citation.score ?? 0),
          0,
        ),
      }))
      .sort((left, right) => {
        if (right.entryCount !== left.entryCount) {
          return right.entryCount - left.entryCount;
        }

        return right.totalScore - left.totalScore;
      });

    const [bestGroup, secondGroup] = rankedGroups;
    if (!bestGroup) {
      return entries;
    }

    if (
      bestGroup.entryCount >= (secondGroup?.entryCount ?? 0) + 2 ||
      bestGroup.totalScore > (secondGroup?.totalScore ?? 0) + 0.5
    ) {
      return bestGroup.entries;
    }

    return entries;
  }

  private buildDeterministicAuditChecklistAnswer(
    userQuery: string,
    citations: ChatCitation[],
  ): string | null {
    if (
      !this.documentationQueryService.isAuditChecklistLookupQuery(userQuery)
    ) {
      return null;
    }

    const entries = this.dedupeDeterministicAuditChecklistEntries(
      citations.flatMap((citation) =>
        this.extractDeterministicAuditChecklistEntries(citation),
      ),
    );
    if (entries.length === 0) {
      return null;
    }

    const selectedEntries = entries.slice(0, 15);
    const omittedEntriesCount = Math.max(
      0,
      entries.length - selectedEntries.length,
    );
    const sourceLabel =
      citations[0]?.sourceTitle ?? 'the cited audit documentation';

    return [
      'The audit or checklist points I extracted are:',
      '',
      ...selectedEntries.map((entry) => `- [${entry.status}] ${entry.point}`),
      ...(omittedEntriesCount > 0
        ? [
            '',
            `Showing the first ${selectedEntries.length} of ${entries.length} matching checklist items from the source documentation.`,
          ]
        : []),
      '',
      `These items are sourced from ${sourceLabel} [Manual: ${sourceLabel}].`,
    ].join('\n');
  }

  private extractDeterministicAuditChecklistEntries(
    citation: ChatCitation,
  ): Array<{ status: string; point: string }> {
    const raw = (citation.snippet ?? '').replace(/\s+/g, ' ').trim();
    if (!raw) return [];

    const lines = raw.split(
      /(?:(?<=[a-z0-9])\s*\|\s*(?=[a-z0-9])|(?<=[.?!])\s+(?=[A-Z]))/i,
    );
    const results: Array<{ status: string; point: string }> = [];

    const passFailRegex =
      /\b(pass|fail|ok|yes|no|finding|defect)\s*[:-]?\s*(.+)/i;

    for (const line of lines) {
      const match = line.match(passFailRegex);
      if (match) {
        const [, status, point] = match;
        if (point.trim().length > 3) {
          results.push({
            status: status.trim().toUpperCase(),
            point: point.trim(),
          });
        }
      }
    }

    return results;
  }

  private dedupeDeterministicAuditChecklistEntries(
    entries: Array<{ status: string; point: string }>,
  ): Array<{ status: string; point: string }> {
    const seen = new Set<string>();
    return entries.filter((entry) => {
      const key = entry.point.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (key.length < 5 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private matchesManualRangeCitationSubject(
    userQuery: string,
    citation: ChatCitation,
  ): boolean {
    const searchSpace =
      `${citation.sourceTitle ?? ''} ${citation.snippet ?? ''}`.toLowerCase();
    const query = userQuery.toLowerCase();

    if (/\bcoolant\b/.test(query) && /\btemperature\b/.test(query)) {
      return (
        /\bcoolant\b/.test(searchSpace) && /\btemperature\b/.test(searchSpace)
      );
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

  private extractDeterministicTankCapacityEntries(
    citation: ChatCitation,
    userQuery: string,
  ): DeterministicTankCapacityEntry[] {
    const tableEntries = this.extractDeterministicTankCapacityTableEntries(
      citation,
      userQuery,
    );
    const normalized = this.normalizeDeterministicContactText(
      citation.snippet ?? '',
    );
    if (!normalized) {
      return tableEntries;
    }

    const haystack =
      `${citation.sourceTitle ?? ''}\n${normalized}`.toLowerCase();
    if (!/\btank\b/i.test(haystack)) {
      return tableEntries;
    }

    const requiresFuel = /\bfuel\b/i.test(userQuery);
    const requiresWater = /\bwater\b/i.test(userQuery);
    if (
      requiresFuel &&
      !/\b(fuel|fueloil|fuel\s+oil|diesel)\b/i.test(haystack)
    ) {
      return tableEntries;
    }
    if (
      requiresWater &&
      !/\b(fresh\s*water|freshwater|water)\b/i.test(haystack)
    ) {
      return tableEntries;
    }

    const pattern =
      /\b((?:(?:fuel|diesel|day|service|settling|storage|fresh\s*water|water|grey|gray|black|waste|holding)\s+)?tank(?:\s+[a-z0-9./-]{1,12}){0,2})(?:\s+(?:capacity|cap\.?|volume))?\s*[:=-]?\s*(\d[\d, .]*\s*(?:l|liters?|litres?|m3|m³|gal|gallons?))\b/gi;

    return [
      ...tableEntries,
      ...[...normalized.matchAll(pattern)]
        .map((match) => {
          const label = match[1]
            ?.replace(/\s+/g, ' ')
            .replace(/\s+(?:capacity|cap\.?|volume)$/i, '')
            .trim();
          const capacity = match[2]?.replace(/\s+/g, ' ').trim();
          if (!label || !capacity) {
            return null;
          }

          return {
            label,
            capacity,
            citation,
          };
        })
        .filter((entry): entry is DeterministicTankCapacityEntry =>
          Boolean(entry),
        ),
    ];
  }

  private extractDeterministicTankCapacityTableEntries(
    citation: ChatCitation,
    userQuery: string,
  ): DeterministicTankCapacityEntry[] {
    const rawSnippet = citation.snippet ?? '';
    if (!/<table[\s\S]*?<tr/i.test(rawSnippet)) {
      return [];
    }

    const requiresFuel = /\bfuel\b/i.test(userQuery);
    const requiresWater = /\bwater\b/i.test(userQuery);
    const tableBlocks = [
      ...rawSnippet.matchAll(/<table[\s\S]*?<\/table>/gi),
    ].map((match) => match[0]);
    const blocks = tableBlocks.length > 0 ? tableBlocks : [rawSnippet];
    const rowPattern =
      /<tr>\s*<t[dh][^>]*>\s*([^<]+?)\s*<\/t[dh]>\s*<t[dh][^>]*>\s*([^<]*tank[^<]*?)\s*<\/t[dh]>\s*<t[dh][^>]*>[^<]*<\/t[dh]>\s*<t[dh][^>]*>\s*([^<]+?)\s*<\/t[dh]>/gi;

    return blocks.flatMap((block) => {
      const normalizedBlock =
        this.normalizeDeterministicContactText(block).toLowerCase();
      if (
        requiresFuel &&
        !/\b(fuel|fueloil|fuel\s+oil|diesel)\b/i.test(normalizedBlock)
      ) {
        return [];
      }
      if (
        requiresWater &&
        !/\b(fresh\s*water|freshwater|water)\b/i.test(normalizedBlock)
      ) {
        return [];
      }

      const unit = this.extractDeterministicTankCapacityHeaderUnit(block);
      return [...block.matchAll(rowPattern)]
        .map((match) => {
          const identifier = this.normalizeDeterministicContactText(
            match[1] ?? '',
          );
          const labelText = this.normalizeDeterministicContactText(
            match[2] ?? '',
          );
          const numericValue = (match[3] ?? '').replace(/\s+/g, ' ').trim();
          if (!labelText || !numericValue || !/\d/.test(numericValue)) {
            return null;
          }

          const label = identifier ? `${identifier} - ${labelText}` : labelText;
          return {
            label,
            capacity: this.formatDeterministicTankCapacityValue(
              numericValue,
              unit,
            ),
            citation,
          };
        })
        .filter((entry): entry is DeterministicTankCapacityEntry =>
          Boolean(entry),
        );
    });
  }

  private extractDeterministicTankCapacityHeaderUnit(
    rawSnippet: string,
  ): string | null {
    const normalized = this.normalizeDeterministicContactText(rawSnippet);
    const headerUnit = normalized.match(/\bcapacity\s*\(([^)]+)\)/i)?.[1];
    if (!headerUnit) {
      return null;
    }

    const unit = headerUnit.toLowerCase().replace(/\s+/g, '');
    if (/^(?:it|lt|l|ltr|ltrs|liter|liters|litre|litres)$/.test(unit)) {
      return 'liters';
    }
    if (/^(?:m3|m³)$/.test(unit)) {
      return 'm3';
    }
    if (/^(?:gal|gallon|gallons|imp\.?gal)$/.test(unit)) {
      return 'gallons';
    }

    return null;
  }

  private formatDeterministicTankCapacityValue(
    value: string,
    unit: string | null,
  ): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (/\b(?:l|liters?|litres?|m3|m³|gal|gallons?)\b/i.test(normalized)) {
      return normalized;
    }
    if (!unit) {
      return normalized;
    }

    return `${normalized} ${unit}`;
  }

  private dedupeDeterministicTankCapacityEntries(
    entries: DeterministicTankCapacityEntry[],
  ): DeterministicTankCapacityEntry[] {
    const deduped = new Map<string, DeterministicTankCapacityEntry>();

    for (const entry of entries) {
      const key = `${entry.label.toLowerCase()}::${entry.capacity.toLowerCase()}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, entry);
        continue;
      }

      const existingScore = existing.citation.score ?? 0;
      const nextScore = entry.citation.score ?? 0;
      if (nextScore > existingScore) {
        deduped.set(key, entry);
      }
    }

    return [...deduped.values()].sort((left, right) =>
      left.label.localeCompare(right.label),
    );
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
      .map(
        (entry) => `${entry.label}: ${this.formatAggregateNumber(entry.value)}`,
      )
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

    return (
      !/\b(based on|depending on|according to|recommended|recommendation|action|next step|next steps|what should i do|what do i do|why|alarm|fault|error|issue|problem|stopp?ed|not working|maintenance|service|procedure|steps?|how to|how do i|manual|documentation|replace|change|install|remove|inspect|troubleshoot(?:ing)?)\b/.test(
        normalized,
      ) &&
      !/\b(normal|range|limit|limits|spec(?:ification)?|specified|operating)\b/.test(
        normalized,
      )
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

  private buildDeterministicTelemetryListAnswer(
    telemetry: Record<string, unknown>,
    options?: {
      sampled?: boolean;
      totalMatchedMetrics?: number;
    },
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

    const visibleCount = entries.length;
    const totalMatchedMetrics = Math.max(
      options?.totalMatchedMetrics ?? visibleCount,
      visibleCount,
    );

    if (visibleCount === 1 && !options?.sampled) {
      const [entry] = entries;
      if (!entry.available) {
        return `I found the matched telemetry metric, but its current value is unavailable: ${entry.label}.`;
      }

      return `The matched telemetry metric is ${entry.label}: ${entry.valueText} [Telemetry].`;
    }

    const lead =
      options?.sampled && totalMatchedMetrics > visibleCount
        ? `I found ${totalMatchedMetrics} matched telemetry metrics. Showing ${visibleCount} sample metrics [Telemetry]:`
        : 'The matched telemetry metrics are [Telemetry]:';

    return [
      lead,
      '',
      ...entries.map((entry) => `- ${entry.label}: ${entry.valueText}`),
    ].join('\n');
  }

  private normalizeDeterministicTelemetryLabel(value: string): string {
    return value.replace(/\s+(?:—|вЂ”|РІР‚вЂќ)\s+/g, ' — ');
  }

  private parseDeterministicTelemetryReadEntry(
    label: string,
    value: unknown,
  ): {
    label: string;
    valueText: string;
    available: boolean;
  } | null {
    const normalizedLabelText =
      this.normalizeDeterministicTelemetryLabel(label);
    const primaryLabel =
      normalizedLabelText.split(' — ')[0]?.trim() ?? normalizedLabelText.trim();
    if (!primaryLabel) {
      return null;
    }

    const unitMatch = normalizedLabelText.match(/Unit:\s*([^\n\r—]+)/i);
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

    const normalizedLabelText =
      this.normalizeDeterministicTelemetryLabel(label);
    const primaryLabel =
      normalizedLabelText.split(' — ')[0]?.trim() ?? normalizedLabelText.trim();
    const normalizedLabel = this.normalizeAggregateTelemetryText(primaryLabel);
    const unitMatch = normalizedLabelText.match(/Unit:\s*([^\n\r—]+)/i);
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
    const units = [
      ...new Set(entries.map((entry) => entry.unit).filter(Boolean)),
    ];
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
      .replace(
        /^(what\s+is|what's|whats|show\s+me|give\s+me|tell\s+me)\s+/i,
        '',
      )
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
    if (this.isExplicitTelemetrySourceQuery(userQuery)) {
      return true;
    }

    if (this.isCurrentPositionTelemetryQuery(userQuery)) {
      return true;
    }

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

  private shouldPreferDocumentationOverCurrentTelemetry(
    queryPlan: ChatQueryPlan,
    userQuery: string,
    semanticQuery?: DocumentationSemanticQuery,
  ): boolean {
    if (!semanticQuery || this.isExplicitTelemetrySourceQuery(userQuery)) {
      return false;
    }

    const documentationIntent = this.isDocumentationSemanticIntent(
      semanticQuery,
    );
    if (!documentationIntent) {
      if (
        semanticQuery.intent === 'general_information' &&
        semanticQuery.sourcePreferences.includes('MANUALS') &&
        this.isProcedureOrDocumentationQuestion(userQuery)
      ) {
        return true;
      }

      return false;
    }

    const reliableSemanticRoute =
      semanticQuery.confidence >= 0.7 ||
      semanticQuery.selectedConceptIds.length > 0 ||
      semanticQuery.sourcePreferences.some(
        (source) => source !== 'MANUALS',
      );
    if (!reliableSemanticRoute) {
      return false;
    }

    if (this.isProcedureOrDocumentationQuestion(userQuery)) {
      return true;
    }

    if (
      semanticQuery.intent === 'general_information' &&
      this.hasSpecificDocumentationAnchor(semanticQuery)
    ) {
      return true;
    }

    switch (queryPlan.primaryIntent) {
      case 'maintenance_procedure':
      case 'troubleshooting':
      case 'manual_specification':
      case 'certificate_status':
      case 'regulation_compliance':
        return true;
      default:
        return false;
    }
  }

  private isDocumentationSemanticIntent(
    semanticQuery: DocumentationSemanticQuery,
  ): boolean {
    switch (semanticQuery.intent) {
      case 'manual_lookup':
      case 'maintenance_procedure':
      case 'operational_procedure':
      case 'troubleshooting':
      case 'parts_lookup':
      case 'regulation_compliance':
      case 'certificate_lookup':
        return true;
      case 'general_information':
        return this.hasSpecificDocumentationAnchor(semanticQuery);
      default:
        return false;
    }
  }

  private hasSpecificDocumentationAnchor(
    semanticQuery: DocumentationSemanticQuery,
  ): boolean {
    return (
      semanticQuery.selectedConceptIds.length > 0 ||
      semanticQuery.equipment.length > 0 ||
      semanticQuery.systems.length > 0 ||
      Boolean(semanticQuery.vendor) ||
      Boolean(semanticQuery.model) ||
      Boolean(semanticQuery.explicitSource) ||
      Boolean(semanticQuery.pageHint) ||
      Boolean(semanticQuery.sectionHint)
    );
  }

  private shouldFailClosedForDocumentationMiss(params: {
    queryPlan: ChatQueryPlan;
    userQuery: string;
    semanticQuery?: DocumentationSemanticQuery;
    citationsForAnswer: ChatCitation[];
    telemetryOnlyQuery: boolean;
    llmTelemetryContext: {
      telemetry: Record<string, unknown>;
    };
  }): boolean {
    const {
      queryPlan,
      userQuery,
      semanticQuery,
      citationsForAnswer,
      telemetryOnlyQuery,
      llmTelemetryContext,
    } = params;

    if (
      citationsForAnswer.length > 0 ||
      telemetryOnlyQuery ||
      Object.keys(llmTelemetryContext.telemetry).length > 0 ||
      this.isExplicitTelemetrySourceQuery(userQuery)
    ) {
      return false;
    }

    return this.shouldPreferDocumentationOverCurrentTelemetry(
      queryPlan,
      userQuery,
      semanticQuery,
    );
  }

  private isProcedureOrDocumentationQuestion(userQuery: string): boolean {
    return /\b(what\s+should\s+i\s+do|what\s+do\s+i\s+do|how\s+should|how\s+do\s+i|procedure|steps?|check\s*list|checklist|instructions?|before|after|prepare|preparation|safely|safe\s+procedure|manual|documentation|according\s+to)\b/i.test(
      userQuery,
    );
  }

  private shouldReturnTelemetryClarification(
    queryPlan: ChatQueryPlan,
    userQuery: string,
  ): boolean {
    if (this.isExplicitTelemetrySourceQuery(userQuery)) {
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
    if (this.isExplicitTelemetrySourceQuery(userQuery)) {
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
    if (this.isExplicitTelemetrySourceQuery(userQuery)) {
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
      /\b(onboard|on\s+board|in\s+(?:the\s+)?tanks?|tank\s+levels?|all\s+fuel\s+tanks|remaining|available)\b/i.test(
        normalized,
      ) ||
      (/\b(fuel|oil|water|coolant|def|urea)\b/i.test(normalized) &&
        /\b(level|levels|quantity|amount|volume|contents?)\b/i.test(
          normalized,
        ) &&
        /\b(tank|tanks)\b/i.test(normalized)) ||
      (/\b(how\s+many|how\s+much|total|combined|sum)\b/i.test(normalized) &&
        /\b(fuel|oil|water|coolant)\b/i.test(normalized))
    );
  }

  private buildTelemetryIntentQuery(params: {
    userQuery: string;
    retrievalQuery?: string;
    resolvedSubjectQuery?: string;
    normalizedQuery: ChatNormalizedQuery;
  }): string {
    const { userQuery, retrievalQuery, resolvedSubjectQuery, normalizedQuery } =
      params;
    let query =
      resolvedSubjectQuery?.trim() ||
      retrievalQuery?.trim() ||
      userQuery.trim();

    if (!query) {
      return userQuery;
    }

    query = this.applyTelemetryOperationIntent(
      query,
      normalizedQuery.operation,
    );

    if (
      normalizedQuery.timeIntent.kind === 'current' &&
      !/\b(current|currently|now|right now|latest|live)\b/i.test(query)
    ) {
      query = this.applyCurrentTelemetryTimeIntent(query);
    }

    return query.replace(/\s+/g, ' ').trim();
  }

  private applyTelemetryOperationIntent(
    query: string,
    operation: ChatNormalizedQuery['operation'],
  ): string {
    if (
      operation !== 'sum' &&
      operation !== 'average' &&
      operation !== 'min' &&
      operation !== 'max'
    ) {
      return query;
    }

    const normalized = query.trim();
    if (!normalized) {
      return normalized;
    }

    const existingPattern =
      operation === 'sum'
        ? /\b(how much|how many|total|sum|overall|combined|together)\b/i
        : operation === 'average'
          ? /\b(average|avg|mean)\b/i
          : operation === 'min'
            ? /\b(min|minimum|lowest|smallest|least)\b/i
            : /\b(max|maximum|highest|peak|largest|greatest)\b/i;
    if (existingPattern.test(normalized)) {
      return normalized;
    }

    const stripped = normalized
      .replace(
        /^(?:what\s+(?:is|was|are|were)|show(?:\s+me)?|list|display|give(?:\s+me)?|tell(?:\s+me)?|provide)\s+/i,
        '',
      )
      .replace(/^the\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const base = stripped || normalized;
    const prefix =
      operation === 'sum'
        ? 'how much total'
        : operation === 'average'
          ? 'average'
          : operation === 'min'
            ? 'minimum'
            : 'maximum';

    return `${prefix} ${base}`.replace(/\s+/g, ' ').trim();
  }

  private applyCurrentTelemetryTimeIntent(query: string): string {
    const stripped = query
      .replace(
        /\b\d+\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\s+ago\b/gi,
        ' ',
      )
      .replace(/\b(?:yesterday|today)\b/gi, ' ')
      .replace(
        /\b(?:last|past|previous)\s+\d+\s+(?:hour|hours|day|days|week|weeks|month|months|year|years)\b/gi,
        ' ',
      )
      .replace(/\b(?:was|were)\b/gi, 'is')
      .replace(/\s+/g, ' ')
      .trim();
    if (!stripped) {
      return 'right now';
    }

    return `${stripped} right now`.replace(/\s+/g, ' ').trim();
  }

  private shouldBlockCurrentTelemetryBecauseHistoricalIntent(
    queryPlan: ChatQueryPlan,
    normalizedQuery: ChatNormalizedQuery,
    historicalResolutionKind: 'none' | 'clarification' | 'answer',
  ): boolean {
    if (historicalResolutionKind !== 'none') {
      return false;
    }

    if (!queryPlan.requiresTelemetryHistory) {
      return false;
    }

    if (
      normalizedQuery.timeIntent.kind !== 'historical_point' &&
      normalizedQuery.timeIntent.kind !== 'historical_range' &&
      normalizedQuery.timeIntent.kind !== 'historical_event'
    ) {
      return false;
    }

    return normalizedQuery.sourceHints.includes('TELEMETRY');
  }

  private isCurrentTelemetryGuidedQuery(userQuery: string): boolean {
    return (
      /\b(current|currently|now|right now|live|actual|status|state|active|inactive|reading|readings|value|values|measured|showing|reads?\s+\d+(?:\.\d+)?|is\s+\d+(?:\.\d+)?|at\s+\d+(?:\.\d+)?)\b/i.test(
        userQuery,
      ) || this.isCurrentPositionTelemetryQuery(userQuery)
    );
  }

  private isExplicitTelemetrySourceQuery(userQuery: string): boolean {
    return /\b(?:based\s+on|from|in|using)\b[\s\S]{0,32}\b(?:the\s+)?(?:telemetry|metrics?)\b/i.test(
      userQuery,
    );
  }

  private isCurrentPositionTelemetryQuery(userQuery: string): boolean {
    const normalized = userQuery.toLowerCase();
    const mentionsPosition =
      /\b(latitude|longitude|location|position|coordinates?|gps|lat|lon)\b/i.test(
        normalized,
      ) ||
      /\bwhere\s+is\s+(?:the\s+)?(?:yacht|vessel|ship|boat)\b/i.test(
        normalized,
      );
    if (!mentionsPosition) {
      return false;
    }

    return (
      /\b(current|currently|now|right now|actual|live)\b/i.test(normalized) ||
      /\bwhere\s+is\s+(?:the\s+)?(?:yacht|vessel|ship|boat)\b/i.test(normalized)
    );
  }
}
