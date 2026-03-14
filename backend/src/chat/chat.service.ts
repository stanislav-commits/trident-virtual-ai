import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatContextService } from './chat-context.service';
import { LlmService } from './llm.service';
import { MetricsService } from '../metrics/metrics.service';
import { CreateChatSessionDto } from './dto/create-chat-session.dto';
import { SendMessageDto } from './dto/send-message.dto';
import {
  ChatSessionResponseDto,
  ChatMessageResponseDto,
} from './dto/chat-response.dto';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contextService: ChatContextService,
    private readonly llmService: LlmService,
    private readonly metricsService: MetricsService,
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
    // Sessions are private per account, regardless of role.
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

    return sessions.map((s) => ({
      ...this.formatSessionResponse(s),
      messageCount: s.messages.length,
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

    if (session.deletedAt)
      throw new NotFoundException('Chat session not found');

    return {
      ...this.formatSessionResponse(session),
      messages: session.messages.map((msg) => this.formatMessageResponse(msg)),
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

    if (session.deletedAt)
      throw new NotFoundException('Chat session not found');

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

    // Auto-generate title from first user message
    this.autoGenerateTitle(sessionId, dto.content).catch((err) =>
      console.error('Failed to auto-generate title:', err),
    );

    this.generateAssistantResponse(
      session.shipId ?? null,
      sessionId,
      dto.content,
      session.ship?.name,
      role,
    ).catch((err) =>
      console.error('Failed to generate assistant response:', err),
    );

    return this.formatMessageResponse(userMessage);
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

    // Only generate title on the first user message and if title is still default
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
          user: { select: { name: true } },
          messages: {
            where: { deletedAt: null },
            orderBy: { createdAt: 'asc' },
            take: 10,
          },
        },
      });

      if (session?.user?.name) {
        const mockData = this.getMockResponse(session.user.name, userQuery);
        if (mockData) {
          // Simulate AI thinking delay based on response length for realistic UX effect
          await new Promise((resolve) => setTimeout(resolve, mockData.delayMs));
          return this.addAssistantMessage(sessionId, mockData.content);
        }
      }

      // RAG context is best-effort: if retrieval fails, continue with telemetry-only response.
      let citations: Array<{
        shipManualId?: string;
        chunkId?: string;
        score?: number;
        pageNumber?: number;
        snippet?: string;
        sourceTitle?: string;
      }> = [];
      const previousUserQuery = this.getPreviousUserQuery(session?.messages);
      const retrievalQuery = this.buildRetrievalQuery(
        userQuery,
        previousUserQuery,
      );
      try {
        if (role === 'admin' || !shipId) {
          citations =
            await this.contextService.findContextForAdminQuery(retrievalQuery);
        } else {
          const result = await this.contextService.findContextForQuery(
            shipId,
            retrievalQuery,
          );
          citations = result.citations;
        }

        // If primary retrieval found nothing, retry with an expanded query.
        if (citations.length === 0) {
          const fallbackQuery = this.buildRagFallbackQuery(retrievalQuery);
          if (fallbackQuery !== retrievalQuery) {
            if (role === 'admin' || !shipId) {
              citations =
                await this.contextService.findContextForAdminQuery(
                  fallbackQuery,
                );
            } else {
              const fallbackResult =
                await this.contextService.findContextForQuery(
                  shipId,
                  fallbackQuery,
                );
              citations = fallbackResult.citations;
            }
          }
        }

        citations = this.pruneCitationsForResolvedSubject(
          retrievalQuery,
          citations,
        );
        citations = this.refineCitationsForIntent(userQuery, citations);
      } catch (error) {
        this.logger.warn(
          `RAG retrieval skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Fetch live telemetry (best-effort, must not block response generation).
      // User mode: selected ship only. Admin mode: aggregate from all ships that have active metrics.
      let telemetry: Record<string, unknown> = {};
      const telemetryShips: string[] = [];
      try {
        if (shipId) {
          telemetry = await this.metricsService.getShipTelemetry(shipId);
          if (shipName) telemetryShips.push(shipName);
        } else if (role === 'admin') {
          const shipsWithMetrics = await this.prisma.ship.findMany({
            where: { metricsConfig: { some: { isActive: true } } },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
          });

          for (const ship of shipsWithMetrics) {
            const shipTelemetry = await this.metricsService.getShipTelemetry(
              ship.id,
            );
            if (Object.keys(shipTelemetry).length > 0) {
              telemetryShips.push(ship.name);
            }
            Object.entries(shipTelemetry).forEach(([label, value]) => {
              telemetry[`[${ship.name}] ${label}`] = value;
            });
          }
        }
      } catch {
        // telemetry is best-effort; don't block the response
      }

      const response = await this.llmService.generateResponse({
        userQuery,
        previousUserQuery:
          retrievalQuery !== userQuery ? previousUserQuery : undefined,
        resolvedSubjectQuery:
          retrievalQuery !== userQuery ? retrievalQuery : undefined,
        citations: citations.map((c) => ({
          snippet: c.snippet || '',
          sourceTitle: c.sourceTitle || 'Unknown',
          pageNumber: c.pageNumber,
        })),
        noDocumentation: citations.length === 0,
        shipName,
        telemetry,
        chatHistory: session?.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      });

      return this.addAssistantMessage(
        sessionId,
        response,
        {
          ...(telemetryShips.length > 0
            ? { telemetryShips: [...new Set(telemetryShips)] }
            : {}),
          ...(citations.length === 0 ? { noDocumentation: true } : {}),
        },
        citations,
      );
    } catch (err) {
      const fallback = `I encountered an issue processing your query: ${err instanceof Error ? err.message : 'Unknown error'}. Please try again or contact support.`;
      return this.addAssistantMessage(sessionId, fallback);
    }
  }

  async addAssistantMessage(
    sessionId: string,
    content: string,
    ragflowContext?: Record<string, unknown> | null,
    contextReferences?: Array<{
      shipManualId?: string;
      chunkId?: string;
      score?: number;
      pageNumber?: number;
      snippet?: string;
      sourceTitle?: string;
      sourceUrl?: string;
    }>,
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

    if (session.deletedAt)
      throw new NotFoundException('Chat session not found');

    if (session.messages.length === 0)
      throw new NotFoundException('Message not found');

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

    if (session.deletedAt)
      throw new NotFoundException('Chat session not found');

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

  private validateAccess(
    session: { userId: string },
    userId: string,
    role: string,
  ): void {
    // Chat session ownership is strict: only creator can access it.
    if (session.userId !== userId) {
      throw new ForbiddenException('Cannot access this chat session');
    }
  }

  private buildRagFallbackQuery(userQuery: string): string {
    const normalized = userQuery.trim().replace(/\s+/g, ' ');
    if (!normalized) return userQuery;

    if (
      /(fault|alarm|error|troubleshoot|issue|problem|not\s+working|failure)/i.test(
        normalized,
      )
    ) {
      return `${normalized}. Focus on alarms, likely causes, limits, troubleshooting and operating procedure.`;
    }

    if (
      /(what\s+maintenance\s+is\s+due|what\s+service\s+is\s+due|due\s+now|maintenance\s+tasks?|service\s+items?|next\s+maintenance|next\s+service)/i.test(
        normalized,
      )
    ) {
      return `${normalized}. Focus on task name, reference ID, interval, last due and next due in the maintenance schedule.`;
    }

    if (
      /\b(parts?|spares?|part\s*numbers?|consumables?|fluids?|oil|coolant|filter|filters)\b/i.test(
        normalized,
      )
    ) {
      return `${normalized}. Focus on spare name, quantity, location, manufacturer part number and supplier part number.`;
    }

    if (
      /\b(procedure|steps?|how\s+to|instruction|instructions|checklist|replace|clean|inspect)\b/i.test(
        normalized,
      )
    ) {
      return `${normalized}. Focus on the documented procedure steps, required materials and cautions.`;
    }

    if (
      /(telemetry|status|current|running\s+hours|hour\s*meter|hours\s*run|runtime)/i.test(
        normalized,
      )
    ) {
      return `${normalized}. Focus on running hours, runtime, hour meter and current status values.`;
    }

    return userQuery;
  }

  private getPreviousUserQuery(
    messages?: Array<{ role: string; content: string }>,
  ): string | undefined {
    if (!messages?.length) return undefined;

    const userMessages = messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content.trim())
      .filter(Boolean);

    if (userMessages.length < 2) return undefined;
    return userMessages[userMessages.length - 2];
  }

  private isContextualFollowUpQuery(query: string): boolean {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return false;

    return /^(yes|yeah|yep|ok|okay|sure|correct|right|no|actually|and\b|also\b|then\b|what about|how about|are you sure|is that correct|is this correct|parts?|spares?|part\s*numbers?|procedure|steps?|details?|tasks?|show all|all tasks|list(?:\s+of)?\s+all\s+tasks|when\s+is\s+the\s+next\s+(maintenance|service)\s+due|what\s+(maintenance|service)\s+is\s+due|what\s+does\s+(it|that)\s+include|what\s+is\s+included)\b/i.test(
      normalized,
    );
  }

  private buildRetrievalQuery(
    userQuery: string,
    previousUserQuery?: string,
  ): string {
    const normalized = userQuery.trim().replace(/\s+/g, ' ');
    if (!normalized || !previousUserQuery) return normalized;
    if (this.isSelfContainedSubjectQuery(normalized)) return normalized;
    if (!this.isContextualFollowUpQuery(normalized)) return normalized;

    const followUp = normalized
      .replace(/^(yes|yeah|yep|ok|okay|sure|correct|right)[,\s]*/i, '')
      .trim();

    if (!followUp) return previousUserQuery.trim();
    if (followUp.toLowerCase() === previousUserQuery.trim().toLowerCase()) {
      return followUp;
    }

    return `${previousUserQuery.trim()}. ${followUp}`;
  }

  private isSelfContainedSubjectQuery(query: string): boolean {
    const normalized = query.trim();
    if (!normalized) return false;

    // Fully phrased questions that already contain a concrete subject should
    // not be merged with the previous turn.
    if (
      /\b(for|about|regarding)\s+(?!it\b|that\b|this\b|them\b|those\b)[a-z0-9]/i.test(
        normalized,
      )
    ) {
      return true;
    }

    const subjectTerms = this.extractRetrievalSubjectTerms(normalized);
    if (subjectTerms.length >= 2) return true;

    if (/\b(reference\s*id|1p\d{2,}|[a-z0-9]+\s+\d+\s*hrs?)\b/i.test(normalized)) {
      return true;
    }

    return false;
  }

  private pruneCitationsForResolvedSubject(
    retrievalQuery: string,
    citations: Array<{
      shipManualId?: string;
      chunkId?: string;
      score?: number;
      pageNumber?: number;
      snippet?: string;
      sourceTitle?: string;
      sourceUrl?: string;
    }>,
  ) {
    if (citations.length === 0) return citations;

    const subjectTerms = this.extractRetrievalSubjectTerms(retrievalQuery);
    if (subjectTerms.length === 0) return citations;

    const matched = citations.filter((citation) => {
      const haystack =
        `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
      return subjectTerms.some((term) => haystack.includes(term));
    });

    if (matched.length >= 2) return matched;
    if (matched.length === 1 && subjectTerms.length >= 2) return matched;
    return citations;
  }

  private refineCitationsForIntent(
    userQuery: string,
    citations: Array<{
      shipManualId?: string;
      chunkId?: string;
      score?: number;
      pageNumber?: number;
      snippet?: string;
      sourceTitle?: string;
      sourceUrl?: string;
    }>,
  ) {
    if (citations.length === 0) return citations;

    let refined = citations;

    const referenceIds = [
      ...new Set(
        (userQuery.match(/\b1p\d{2,}\b/gi) ?? []).map((value) =>
          value.toLowerCase(),
        ),
      ),
    ];

    if (referenceIds.length > 0) {
      const matchedByReference = refined.filter((citation) => {
        const haystack =
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
        return referenceIds.some((referenceId) => haystack.includes(referenceId));
      });
      if (matchedByReference.length > 0) {
        refined = matchedByReference;
      }
    }

    const numericTokens = this.extractSignificantNumericTokens(userQuery);
    if (numericTokens.length > 0) {
      const matchedByNumericToken = refined.filter((citation) => {
        const haystack =
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
        return numericTokens.some((token) => haystack.includes(token));
      });
      if (matchedByNumericToken.length > 0) {
        refined = matchedByNumericToken;
      }
    }

    if (this.isPartsQuery(userQuery)) {
      const matchedParts = refined.filter((citation) =>
        /\b(spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location)\b/i.test(
          citation.snippet ?? '',
        ),
      );
      if (matchedParts.length > 0) {
        refined = matchedParts;
      }
    }

    if (this.isNextDueLookupQuery(userQuery)) {
      const matchedNextDue = refined.filter((citation) =>
        /\bnext\s*due\b/i.test(citation.snippet ?? ''),
      );
      if (matchedNextDue.length > 0) {
        refined = matchedNextDue;
      }
    }

    return refined;
  }

  private extractRetrievalSubjectTerms(query: string): string[] {
    const stopWords = new Set([
      'what',
      'when',
      'where',
      'why',
      'how',
      'about',
      'next',
      'maintenance',
      'service',
      'due',
      'hours',
      'hour',
      'running',
      'current',
      'status',
      'please',
      'provide',
      'show',
      'list',
      'task',
      'tasks',
      'details',
      'parts',
      'part',
      'procedure',
      'steps',
      'include',
      'included',
      'does',
      'that',
      'this',
      'it',
      'the',
      'for',
      'all',
      'is',
      'are',
    ]);

    return [
      ...new Set(
        query
          .toLowerCase()
          .replace(/[^a-z0-9\s/-]/g, ' ')
          .split(/\s+/)
          .map((term) => term.trim())
          .filter((term) => term.length >= 3)
          .filter((term) => !stopWords.has(term))
          .filter((term) => !/^\d+$/.test(term)),
      ),
    ];
  }

  private isPartsQuery(query: string): boolean {
    return /\b(parts?|spares?|part\s*numbers?|consumables?|filters?|oil|coolant)\b/i.test(
      query,
    );
  }

  private isNextDueLookupQuery(query: string): boolean {
    return /\b(next\s+due|what\s+is\s+next\s+due|next\s+due\s+value|when\s+is\s+the\s+next\s+(maintenance|service)\s+due)\b/i.test(
      query,
    );
  }

  private extractSignificantNumericTokens(query: string): string[] {
    const tokens = new Set<string>();

    for (const match of query.matchAll(/\b(\d{2,6})\s*(hrs?|hours?)\b/gi)) {
      tokens.add(match[1]);
    }

    for (const match of query.matchAll(/\b1p\d{2,}\b/gi)) {
      tokens.add(match[0].toLowerCase());
    }

    return [...tokens];
  }

  private getMockResponse(
    userName: string,
    query: string,
  ): { content: string; delayMs: number } | null {
    if (userName.trim().toLowerCase() !== 'shaun') {
      return null;
    }

    const q = query.trim().toLowerCase();
    
    // Helper to calculate delay based on word count (approx 25 words per second) plus a base delay
    const calculateDelay = (text: string) => {
      const wordCount = text.split(/\s+/).length;
      return Math.min(Math.max(2000, (wordCount / 25) * 1000), 10000); // Between 2s and 10s
    };

    if (/generator.*running\s*hours/i.test(q)) {
      const content = `The port generator has 2004 running hours.

Would you like to know:

<action-button>When the next maintenance is due and what this includes</action-button>

<action-button>How to carry out the next maintenance</action-button>

<action-button>Part numbers and locations for the required spares</action-button>

<action-button>Show all</action-button>`;
      return { content, delayMs: calculateDelay(content) };
    }

    if (/(when.*next\s*maintenance|what.*includes)/i.test(q) && !/how/i.test(q)) {
      const content = `The next scheduled service is due at 2200 hours and includes the following:

- Change Engine Oil
- Replace Engine Oil Filter
- Replace Air Filter
- Replace Fuel Filters and Prefilters
- Replace the Impeller
- Inspect and Replace Alternator Belt
- Check Coolant Level
- Inspect Zincs
- General routine checks such as signs of fluid or gas leaks.`;
      return { content, delayMs: calculateDelay(content) };
    }

    if (/(how.*oil\s*and\s*filter|how.*carry\s*out.*maintenance)/i.test(q)) {
      const content = `**Tools and Materials Needed:**
- New engine oil <high-light>(12 litres of 15w40)</high-light>
- New oil filter
- Oil filter wrench
- Oil drain pan
- Funnel
- Rags or paper towels
- Safety gloves
- Trident Virtual headset for recording of the job

**Step-by-Step Instructions:**

1. Ensure the generator is turned off and has cooled down.
2. Disconnect the battery to prevent accidental start-up and place a lock out tag.
3. Drain the oil:
   - Locate the oil drain plug on the bottom of the oil pan. Refer to the generator's manual if necessary.
   - Place the oil drain pan under the oil drain plug. Remove the drain plug and allow the old oil to completely drain into the pan. This may take several minutes.
4. Remove the Old Oil Filter:
   - Use the oil filter wrench to loosen and remove the old oil filter. Be cautious as it may still contain some oil. Wipe the area around the oil filter mount to remove any debris.
5. Install the New Oil Filter:
   - Before installing the new oil filter, apply a small amount of new oil to the rubber gasket on the new filter. This helps create a better seal.
   - Screw the new oil filter onto the mount by hand until snug. Do not overtighten.
6. Replace the Drain Plug:
   - Once all the old oil has drained, replace and tighten the drain plug securely.
7. Add New Engine Oil:
   - Locate the oil fill cap on the engine. Remove it and use a funnel to pour in the new engine oil. This will be approximately <high-light>12 litres</high-light> of 15w40.
8. Check Oil Level:
   - After adding oil, wait a few minutes for it to settle, then check the oil level using the dipstick. Add more oil if necessary until it reaches the proper level marked by U A L on the dipstick.
9. Run the Engine:
   - Reconnect the battery and start the generator in local. Let it run for a few minutes while checking for leaks around the oil filter and drain plug.
10. Dispose of Old Oil and Filter:
    - Properly dispose of the old oil and filter according to MARPOL.

**Safety Warnings:**
- Always wear gloves and goggles to protect against oil spills and splashes.
- Ensure the generator is completely cool before starting the oil change to avoid burns.
- Follow proper disposal methods for used oil and filters in accordance with MARPOL.`;
      return { content, delayMs: calculateDelay(content) };
    }

    if (/part\s*number/i.test(q)) {
      const content = `For the 200 hourly maintenance on the port generator you will require the following:

- **Volvo Penta - Oil Bypass Filter** (Qty: 1) – <high-light>Part number: 21951346</high-light>
  - Locations: Box 23 (Volvo Penta Oil Filters) & Box 22 (Volvo Penta Oil Filters).
- **Volvo Penta - Oil Filter Element** (Qty: 2) - <high-light>Part number: 477556</high-light>
  - Locations: Box 21 (Volvo Penta Oil Filters) & Box 22 (Volvo Penta Oil Filters).
- **Racor Cartridges – Fuel filter element** (Qty: 1) - <high-light>Part number: 2020PM</high-light>
  - Locations: Box 20 (Racor Filters) & Box 24 (Volvo Penta Fuel Filter).
- **Oil – 15W40** (Qty 12 Litres) – <high-light>Part Number: 15W40 Oil</high-light>
  - Locations: Bilge SB Steering Room.`;
      return { content, delayMs: calculateDelay(content) };
    }

    if (/show\s*all/i.test(q)) {
      const content = `The next scheduled service is due at 2200 hours and includes the following:

- Change Engine Oil
- Replace Engine Oil Filter
- Replace Air Filter
- Replace Fuel Filters and Prefilters
- Replace the Impeller
- Inspect and Replace Alternator Belt
- Check Coolant Level
- Inspect Zincs
- General routine checks such as signs of fluid or gas leaks.

---

**Tools and Materials Needed:**
- New engine oil <high-light>(12 litres of 15w40)</high-light>
- New oil filter
- Oil filter wrench
- Oil drain pan
- Funnel
- Rags or paper towels
- Safety gloves
- Trident Virtual headset for recording of the job

**Step-by-Step Instructions:**

1. Ensure the generator is turned off and has cooled down.
2. Disconnect the battery to prevent accidental start-up and place a lock out tag.
3. Drain the oil:
   - Locate the oil drain plug on the bottom of the oil pan. Refer to the generator's manual if necessary.
   - Place the oil drain pan under the oil drain plug. Remove the drain plug and allow the old oil to completely drain into the pan. This may take several minutes.
4. Remove the Old Oil Filter:
   - Use the oil filter wrench to loosen and remove the old oil filter. Be cautious as it may still contain some oil. Wipe the area around the oil filter mount to remove any debris.
5. Install the New Oil Filter:
   - Before installing the new oil filter, apply a small amount of new oil to the rubber gasket on the new filter. This helps create a better seal.
   - Screw the new oil filter onto the mount by hand until snug. Do not overtighten.
6. Replace the Drain Plug:
   - Once all the old oil has drained, replace and tighten the drain plug securely.
7. Add New Engine Oil:
   - Locate the oil fill cap on the engine. Remove it and use a funnel to pour in the new engine oil. This will be approximately <high-light>12 litres</high-light> of 15w40.
8. Check Oil Level:
   - After adding oil, wait a few minutes for it to settle, then check the oil level using the dipstick. Add more oil if necessary until it reaches the proper level marked by U A L on the dipstick.
9. Run the Engine:
   - Reconnect the battery and start the generator in local. Let it run for a few minutes while checking for leaks around the oil filter and drain plug.
10. Dispose of Old Oil and Filter:
    - Properly dispose of the old oil and filter according to MARPOL.

**Safety Warnings:**
- Always wear gloves and goggles to protect against oil spills and splashes.
- Ensure the generator is completely cool before starting the oil change to avoid burns.
- Follow proper disposal methods for used oil and filters in accordance with MARPOL.

---

For the 200 hourly maintenance on the port generator you will require the following:

- **Volvo Penta - Oil Bypass Filter** (Qty: 1) – <high-light>Part number: 21951346</high-light>
  - Locations: Box 23 (Volvo Penta Oil Filters) & Box 22 (Volvo Penta Oil Filters).
- **Volvo Penta - Oil Filter Element** (Qty: 2) - <high-light>Part number: 477556</high-light>
  - Locations: Box 21 (Volvo Penta Oil Filters) & Box 22 (Volvo Penta Oil Filters).
- **Racor Cartridges – Fuel filter element** (Qty: 1) - <high-light>Part number: 2020PM</high-light>
  - Locations: Box 20 (Racor Filters) & Box 24 (Volvo Penta Fuel Filter).
- **Oil – 15W40** (Qty 12 Litres) – <high-light>Part Number: 15W40 Oil</high-light>
  - Locations: Bilge SB Steering Room.`;

      return { content, delayMs: calculateDelay(content) };
    }

    if (/what\s*happened/i.test(q) || /yacht\s*stopped/i.test(q) || /generator\s*stopped/i.test(q)) {
      const content = `Common causes to check include:
- Low fuel supply
- Low battery voltage
- Overheating
- Fault alarm or shutdown
- Low oil pressure
- Cooling water flow issue

**Start with these quick checks:**
- Active alarm or fault message
- Fuel level in the tank
- Air in the fuel system (vent the filters)
- Battery voltage, should be a minimum of 24V
- Cooling water flow, check the sea water system valve configuration and the pump for any air
- Coolant header tank, check the header tank level
- Oil level
- Emergency stop status

If the fault remains, review the last shutdown alarm and contact Trident Virtual for remote assistance.`;
      return { content, delayMs: calculateDelay(content) };
    }

    return null;
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
}
