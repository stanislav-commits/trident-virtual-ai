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
      try {
        if (role === 'admin' || !shipId) {
          citations =
            await this.contextService.findContextForAdminQuery(userQuery);
        } else {
          const result = await this.contextService.findContextForQuery(
            shipId,
            userQuery,
          );
          citations = result.citations;
        }

        // If primary retrieval found nothing, retry with an expanded query.
        if (citations.length === 0) {
          const fallbackQuery = this.buildRagFallbackQuery(userQuery);
          if (fallbackQuery !== userQuery) {
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
    return `${normalized}. Include normal range, limits, alarms, troubleshooting and operating procedure.`;
  }

  private getMockResponse(
    userName: string,
    query: string,
  ): { content: string; delayMs: number } | null {
    if (userName.trim().toLowerCase() !== 'Shaun') {
      return null;
    }

    const q = query.trim().toLowerCase();
    
    // Helper to calculate delay based on word count (approx 25 words per second) plus a base delay
    const calculateDelay = (text: string) => {
      const wordCount = text.split(/\s+/).length;
      return Math.min(Math.max(2000, (wordCount / 25) * 1000), 10000); // Between 2s and 10s
    };

    if (/generator.*running\s*hours/i.test(q)) {
      const content = `The running hours for the port generator, based on the telemetry data provided, are 2004 hours.

This indicates the total operational time the generator has been running since its last reset or maintenance. If you need further information or specific maintenance guidelines based on these running hours, please let me know.`;
      return { content, delayMs: calculateDelay(content) };
    }

    if (/next\s*maintenance/i.test(q)) {
      const content = `Based on the engine running hours of **2004 hours** for the MASE generator, the next maintenance should be scheduled after the next 200-hour interval. Therefore, the next maintenance will be due at **2200 hours** of engine operation.

**Upcoming Maintenance Tasks at 2200 Hours:**
- Change Engine Oil
- Replace Engine Oil Filter
- Replace Air Filter
- Replace Fuel Filters and Prefilters
- Replace the Impeller
- Inspect and Replace Alternator Belt
- Check Coolant Level
- Inspect Zincs
- Conduct General Routine Checks

Make sure to keep track of the engine running hours to ensure timely maintenance. If you have any further questions or need assistance with specific tasks, feel free to ask!`;
      return { content, delayMs: calculateDelay(content) };
    }

    if (/how\s*to.*oil\s*and\s*filter/i.test(q)) {
      const content = `To change the engine oil and filter for the MASE generator, follow these step-by-step instructions:

### Tools and Materials Needed:
- New engine oil (as specified in the manual)
- New oil filter
- Oil filter wrench
- Oil drain pan
- Funnel
- Rags or paper towels
- Safety gloves and goggles

### Step-by-Step Instructions:

**1. Prepare the Generator:**
Ensure the generator is turned off and has cooled down.
Disconnect the battery to prevent accidental start-up.

**2. Access the Oil Drain:**
Locate the oil drain plug on the bottom of the oil pan. Refer to the generator's manual if necessary.

**3. Drain the Old Oil:**
Place the oil drain pan under the oil drain plug.
Remove the drain plug and allow the old oil to completely drain into the pan. This may take several minutes.

**4. Remove the Old Oil Filter:**
Use the oil filter wrench to loosen and remove the old oil filter. Be cautious as it may still contain some oil.
Wipe the area around the oil filter mount to remove any debris.

**5. Install the New Oil Filter:**
Before installing the new oil filter, apply a small amount of new oil to the rubber gasket on the new filter. This helps create a better seal.
Screw the new oil filter onto the mount by hand until snug. Do not overtighten.

**6. Replace the Drain Plug:**
Once all the old oil has drained, replace and tighten the drain plug securely.

**7. Add New Engine Oil:**
Locate the oil fill cap on the engine. Remove it and use a funnel to pour in the new engine oil.
Refer to the manual for the correct oil type and capacity [2][5].

**8. Check Oil Level:**
After adding oil, wait a few minutes for it to settle, then check the oil level using the dipstick. Add more oil if necessary until it reaches the proper level.

**9. Run the Engine:**
Reconnect the battery and start the generator. Let it run for a few minutes while checking for leaks around the oil filter and drain plug.

**10. Dispose of Old Oil and Filter:**
Properly dispose of the old oil and filter according to local regulations.

### Safety Warnings:
- Always wear gloves and goggles to protect against oil spills and splashes.
- Ensure the generator is completely cool before starting the oil change to avoid burns.
- Follow proper disposal methods for used oil and filters to protect the environment.

By following these steps, you will ensure that the engine oil and filter are changed correctly, maintaining the generator's performance and longevity. If you have any further questions or need clarification, feel free to ask!`;
      return { content, delayMs: calculateDelay(content) };
    }

    if (/yacht\s*stopped/i.test(q)) {
      const content = `If your yacht has stopped, it is crucial to diagnose the issue promptly. Here are step-by-step instructions to troubleshoot the situation:

**1. Check Fuel Supply:**
Ensure that there is sufficient fuel in the tank. If the fuel gauge indicates low levels, refuel if possible.

**2. Inspect Electrical Systems:**
Check the battery voltage. If the batteries are low, attempt to recharge or jump-start them.
Ensure that all electrical connections are secure and free from corrosion.

**3. Examine Engine Indicators:**
Look for any warning lights or alarms on the dashboard. Note any specific error codes or indicators that may provide clues.

**4. Check for Overheating:**
Verify that the engine is not overheating. If the temperature gauge is high, allow the engine to cool down and check the coolant levels.

**5. Inspect for Mechanical Issues:**
Listen for unusual noises when attempting to restart the engine. Grinding or clunking sounds may indicate mechanical failure.
Check for any visible leaks or damage in the engine compartment.

**6. Review Recent Maintenance:**
If the S-Band gearbox or other critical components were recently serviced, ensure that everything was reassembled correctly and that no parts were left loose.

**7. Attempt to Restart:**
After checking the above items, try to restart the engine. If it does not start, note any sounds or lack thereof.

**8. Call for Assistance:**
If you are unable to identify or resolve the issue, contact a marine technician or your yacht's support service for professional assistance.

**Safety Warning:** Always ensure that you are in a safe location and that the yacht is secured before performing any checks. If you are in a potentially hazardous situation, prioritize safety and seek help immediately.`;
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
