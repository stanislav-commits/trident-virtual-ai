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

    return sessions.map((session) => ({
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
              create: contextReferences,
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

      let telemetry: Record<string, unknown> = {};
      let telemetryPrefiltered = false;
      let telemetryMatchMode: TelemetryMatchMode = 'none';
      let telemetryClarification: TelemetryClarification | null = null;
      const telemetryShips: string[] = [];
      try {
        if (shipId) {
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
        } else if (role === 'admin') {
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

      if (telemetryClarification && telemetryClarification.actions.length > 0) {
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
        /\b(based\s+on|recommended|recommendation|action|next\s+step|what\s+should\s+i\s+do|what\s+do\s+i\s+do|procedure|steps?|how\s+to|how\s+do\s+i|manual|documentation|according\s+to\s+(?:the\s+)?(?:manual|documentation|docs?|handbook|guide|procedure|spec(?:ification)?))\b/i;
      const telemetryOnlyQuery =
        /\bfrom\s+telemetry\b|\btelemetry\s+only\b|\bfrom\s+metrics\b/i.test(
          effectiveUserQuery,
        ) ||
        telemetryMatchMode === 'sample' ||
        ((telemetryMatchMode === 'exact' || telemetryMatchMode === 'direct') &&
          !documentationIntentPattern.test(effectiveUserQuery));

      const citationsForAnswer = telemetryOnlyQuery ? [] : citations;

      const deterministicTelemetryAnswer = this.buildDeterministicTelemetryAnswer(
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
            ...(citationsForAnswer.length === 0 ? { noDocumentation: true } : {}),
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
          pageNumber: citation.pageNumber,
        })),
        noDocumentation: citationsForAnswer.length === 0,
        shipName,
        telemetry,
        telemetryPrefiltered,
        telemetryMatchMode,
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
          ...(citationsForAnswer.length === 0 ? { noDocumentation: true } : {}),
        },
        citationsForAnswer,
      );
    } catch (error) {
      const fallback = `I encountered an issue processing your query: ${error instanceof Error ? error.message : 'Unknown error'}. Please try again or contact support.`;
      return this.addAssistantMessage(sessionId, fallback);
    }
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
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  }): ChatSessionResponseDto {
    return {
      id: session.id,
      title: session.title ?? undefined,
      userId: session.userId,
      shipId: session.shipId,
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
    userQuery: string,
    telemetry: Record<string, unknown>,
    telemetryPrefiltered: boolean,
    telemetryMatchMode: TelemetryMatchMode,
  ): string | null {
    if (!telemetryPrefiltered) {
      return null;
    }

    if (telemetryMatchMode !== 'exact' && telemetryMatchMode !== 'direct') {
      return null;
    }

    return this.buildDeterministicAggregateTelemetryAnswer(userQuery, telemetry);
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
        `The ${subject} from the current matched telemetry readings is ${totalValue}${unitSuffix}.`,
        '',
        valuesList,
        `Total = ${formula} = ${totalValue}${unitSuffix}.`,
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
        `The average of the current matched telemetry readings is ${averageValue}${unitSuffix}.`,
        '',
        valuesList,
        `Average = (${formula}) / ${orderedEntries.length} = ${averageValue}${unitSuffix}.`,
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
      `The ${qualifier} current matched telemetry reading is ${selectedEntry.label}: ${this.formatAggregateNumber(selectedEntry.value)}${unitSuffix}.`,
      '',
      valuesList,
    ].join('\n');
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
}
