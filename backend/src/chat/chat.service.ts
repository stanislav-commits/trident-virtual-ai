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
          await new Promise((resolve) => setTimeout(resolve, mockData.delayMs));
          return this.addAssistantMessage(sessionId, mockData.content);
        }
      }

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
          },
          [],
        );
      }

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
        // Telemetry is best-effort and must not block the answer.
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
        citations: citations.map((citation) => ({
          snippet: citation.snippet || '',
          sourceTitle: citation.sourceTitle || 'Unknown',
          pageNumber: citation.pageNumber,
        })),
        noDocumentation: citations.length === 0,
        shipName,
        telemetry,
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
          ...(citations.length === 0 ? { noDocumentation: true } : {}),
        },
        citations,
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

  private getMockResponse(
    userName: string,
    query: string,
  ): { content: string; delayMs: number } | null {
    if (userName.trim().toLowerCase() !== 'shaun') {
      return null;
    }

    const q = query.trim().toLowerCase();

    const calculateDelay = (text: string) => {
      const wordCount = text.split(/\s+/).length;
      return Math.min(Math.max(2000, (wordCount / 25) * 1000), 10000);
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

- **Volvo Penta - Oil Bypass Filter** (Qty: 1) - <high-light>Part number: 21951346</high-light>
  - Locations: Box 23 (Volvo Penta Oil Filters) & Box 22 (Volvo Penta Oil Filters).
- **Volvo Penta - Oil Filter Element** (Qty: 2) - <high-light>Part number: 477556</high-light>
  - Locations: Box 21 (Volvo Penta Oil Filters) & Box 22 (Volvo Penta Oil Filters).
- **Racor Cartridges - Fuel filter element** (Qty: 1) - <high-light>Part number: 2020PM</high-light>
  - Locations: Box 20 (Racor Filters) & Box 24 (Volvo Penta Fuel Filter).
- **Oil - 15W40** (Qty 12 Litres) - <high-light>Part Number: 15W40 Oil</high-light>
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

- **Volvo Penta - Oil Bypass Filter** (Qty: 1) - <high-light>Part number: 21951346</high-light>
  - Locations: Box 23 (Volvo Penta Oil Filters) & Box 22 (Volvo Penta Oil Filters).
- **Volvo Penta - Oil Filter Element** (Qty: 2) - <high-light>Part number: 477556</high-light>
  - Locations: Box 21 (Volvo Penta Oil Filters) & Box 22 (Volvo Penta Oil Filters).
- **Racor Cartridges - Fuel filter element** (Qty: 1) - <high-light>Part number: 2020PM</high-light>
  - Locations: Box 20 (Racor Filters) & Box 24 (Volvo Penta Fuel Filter).
- **Oil - 15W40** (Qty 12 Litres) - <high-light>Part Number: 15W40 Oil</high-light>
  - Locations: Bilge SB Steering Room.`;

      return { content, delayMs: calculateDelay(content) };
    }

    if (
      /what\s*happened/i.test(q) ||
      /yacht\s*stopped/i.test(q) ||
      /generator\s*stopped/i.test(q)
    ) {
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
