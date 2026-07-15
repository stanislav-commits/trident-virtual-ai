import { formatError } from '../../common/utils/error.utils';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { ShipsQueryService } from '../ships/ships-query.service';
import { ChatLlmService } from './chat-llm.service';
import {
  formatConversationSummary,
  formatMessageTranscript,
} from './context/chat-context-prompt.utils';
import { toChatSessionResponse } from './chat.mapper';
import { CreateChatSessionDto } from './dto/create-chat-session.dto';
import { ListChatSessionsQueryDto } from './dto/list-chat-sessions-query.dto';
import { SetChatSessionPinDto } from './dto/set-chat-session-pin.dto';
import { UpdateChatSessionDto } from './dto/update-chat-session.dto';
import { ChatMessageEntity } from './entities/chat-message.entity';
import { ChatSessionEntity } from './entities/chat-session.entity';
import { ChatMessageRole } from './enums/chat-message-role.enum';
import { ChatSessionTitleStatus } from './enums/chat-session-title-status.enum';

const DEFAULT_CHAT_TITLE = 'New Chat';
const DEFAULT_SESSION_LIMIT = 20;
const CHAT_TITLE_RECENT_MESSAGE_LIMIT = 8;
const CHAT_TITLE_MAX_LENGTH = 80;
const CHAT_TITLE_REFINED_MIN_USER_MESSAGES = 2;

@Injectable()
export class ChatSessionsService {
  private readonly logger = new Logger(ChatSessionsService.name);

  constructor(
    @InjectRepository(ChatSessionEntity)
    private readonly chatSessionsRepository: Repository<ChatSessionEntity>,
    @InjectRepository(ChatMessageEntity)
    private readonly chatMessagesRepository: Repository<ChatMessageEntity>,
    private readonly shipsQueryService: ShipsQueryService,
    private readonly chatLlmService: ChatLlmService,
  ) {}

  async list(user: AuthenticatedUser, query: ListChatSessionsQueryDto) {
    const limit = this.normalizeLimit(query.limit);
    const offset = this.parseCursor(query.cursor);
    const search = query.search?.trim() ?? '';

    const queryBuilder = this.chatSessionsRepository
      .createQueryBuilder('session')
      .where('session.user_id = :userId', { userId: user.id })
      .andWhere('session.deleted_at IS NULL')
      .orderBy('session.pinned_at', 'DESC', 'NULLS LAST')
      .addOrderBy('session.updated_at', 'DESC')
      .addOrderBy('session.id', 'DESC')
      .skip(offset)
      .take(limit + 1);

    if (search) {
      queryBuilder.andWhere('COALESCE(session.title, \'\') ILIKE :search', {
        search: `%${this.escapeLike(search)}%`,
      });
    }

    const rows = await queryBuilder.getMany();
    const hasMore = rows.length > limit;
    const sessions = rows.slice(0, limit);
    const messageCounts = await this.loadMessageCounts(
      sessions.map((session) => session.id),
    );

    return {
      sessions: sessions.map((session) =>
        toChatSessionResponse(session, {
          messageCount: messageCounts.get(session.id) ?? 0,
        }),
      ),
      nextCursor: hasMore ? String(offset + limit) : null,
      hasMore,
    };
  }

  async create(user: AuthenticatedUser, input: CreateChatSessionDto) {
    const shipId = await this.resolveShipId(user, input.shipId);
    const title = this.normalizeTitle(input.title);
    const entity = this.chatSessionsRepository.create({
      title,
      titleStatus: this.resolveInitialTitleStatus(title),
      userId: user.id,
      shipId,
      pinnedAt: null,
    });

    const saved = await this.chatSessionsRepository.save(entity);
    return toChatSessionResponse(saved, { messageCount: 0, messages: [] });
  }

  async getOne(user: AuthenticatedUser, sessionId: string) {
    const session = await this.findAccessibleSessionOrThrow(user, sessionId, {
      ship: true,
    });
    const messages = await this.chatMessagesRepository.find({
      where: {
        sessionId: session.id,
        deletedAt: IsNull(),
      },
      order: { createdAt: 'ASC' },
    });

    return toChatSessionResponse(session, {
      messageCount: messages.length,
      messages,
    });
  }

  async rename(
    user: AuthenticatedUser,
    sessionId: string,
    input: UpdateChatSessionDto,
  ) {
    const session = await this.findAccessibleSessionOrThrow(user, sessionId);
    const normalizedTitle = this.normalizeRequiredTitle(input.title);

    session.title = normalizedTitle;
    session.titleStatus = ChatSessionTitleStatus.MANUAL;
    session.updatedAt = new Date();

    const saved = await this.chatSessionsRepository.save(session);
    const messageCount = await this.countMessages(saved.id);

    return toChatSessionResponse(saved, { messageCount });
  }

  async setPinned(
    user: AuthenticatedUser,
    sessionId: string,
    input: SetChatSessionPinDto,
  ) {
    const session = await this.findAccessibleSessionOrThrow(user, sessionId);

    session.pinnedAt = input.isPinned ? new Date() : null;
    session.updatedAt = new Date();

    const saved = await this.chatSessionsRepository.save(session);
    const messageCount = await this.countMessages(saved.id);

    return toChatSessionResponse(saved, { messageCount });
  }

  async remove(user: AuthenticatedUser, sessionId: string): Promise<void> {
    const session = await this.findAccessibleSessionOrThrow(user, sessionId);

    await this.chatMessagesRepository.softDelete({ sessionId: session.id });
    await this.chatSessionsRepository.softDelete(session.id);
  }

  async findAccessibleSessionOrThrow(
    user: AuthenticatedUser,
    sessionId: string,
    relations: {
      ship?: boolean;
      user?: boolean;
    } = {},
  ): Promise<ChatSessionEntity> {
    const session = await this.chatSessionsRepository.findOne({
      where: {
        id: sessionId,
        userId: user.id,
        deletedAt: IsNull(),
      },
      relations,
    });

    if (!session) {
      throw new NotFoundException('Chat session not found');
    }

    return session;
  }

  async findSessionById(
    sessionId: string,
    relations: {
      ship?: boolean;
      user?: boolean;
    } = {},
  ): Promise<ChatSessionEntity | null> {
    return this.chatSessionsRepository.findOne({
      where: {
        id: sessionId,
        deletedAt: IsNull(),
      },
      relations,
    });
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.chatSessionsRepository.update(
      { id: sessionId, deletedAt: IsNull() },
      { updatedAt: new Date() },
    );
  }

  async applyUserMessageActivity(sessionId: string): Promise<void> {
    const session = await this.chatSessionsRepository.findOne({
      where: {
        id: sessionId,
        deletedAt: IsNull(),
      },
    });

    if (!session) {
      return;
    }

    if (
      !session.title?.trim() &&
      session.titleStatus !== ChatSessionTitleStatus.MANUAL
    ) {
      session.title = DEFAULT_CHAT_TITLE;
    }

    session.updatedAt = new Date();
    await this.chatSessionsRepository.save(session);
  }

  async refreshAutoTitleAfterTurn(input: {
    sessionId: string;
    messages: ChatMessageEntity[];
    summary: string | null;
  }): Promise<string | null> {
    try {
      return await this.refreshAutoTitleAfterTurnUnsafe(input);
    } catch (error) {
      this.logger.warn(
        `Failed to refresh chat title for session ${input.sessionId}: ${
          formatError(error)
        }`,
      );
      return null;
    }
  }

  private async refreshAutoTitleAfterTurnUnsafe(input: {
    sessionId: string;
    messages: ChatMessageEntity[];
    summary: string | null;
  }): Promise<string | null> {
    const activeMessages = input.messages.filter(
      (message) => !message.deletedAt,
    );
    const userMessageCount = activeMessages.filter(
      (message) => message.role === ChatMessageRole.USER,
    ).length;

    if (userMessageCount === 0 || activeMessages.length < 2) {
      return null;
    }

    const session = await this.chatSessionsRepository.findOne({
      where: {
        id: input.sessionId,
        deletedAt: IsNull(),
      },
      relations: {
        ship: true,
      },
    });

    if (!session || session.titleStatus === ChatSessionTitleStatus.MANUAL) {
      return null;
    }

    const shouldRefine =
      userMessageCount >= CHAT_TITLE_REFINED_MIN_USER_MESSAGES;

    if (session.titleStatus === ChatSessionTitleStatus.AUTO_REFINED) {
      return null;
    }

    if (!shouldRefine && this.hasGeneratedAutoTitle(session.title)) {
      return null;
    }

    const generatedTitle = this.normalizeGeneratedTitle(
      await this.generateContextualTitle({
        session,
        messages: activeMessages.slice(-CHAT_TITLE_RECENT_MESSAGE_LIMIT),
        summary: input.summary,
        isRefinement: shouldRefine,
      }),
    );

    if (!generatedTitle) {
      return null;
    }

    const nextStatus = shouldRefine
      ? ChatSessionTitleStatus.AUTO_REFINED
      : ChatSessionTitleStatus.AUTO_INITIAL;

    await this.chatSessionsRepository.update(
      {
        id: session.id,
        deletedAt: IsNull(),
        titleStatus: session.titleStatus,
      },
      {
        title: generatedTitle,
        titleStatus: nextStatus,
        updatedAt: new Date(),
      },
    );

    return generatedTitle;
  }

  private async resolveShipId(
    user: AuthenticatedUser,
    requestedShipId?: string | null,
  ): Promise<string | null> {
    if (user.role === UserRole.USER) {
      if (!user.shipId) {
        throw new BadRequestException('Regular user must be assigned to a ship');
      }

      const ship = await this.shipsQueryService.findById(user.shipId);

      if (!ship) {
        throw new BadRequestException('Assigned ship not found');
      }

      return ship.id;
    }

    const normalizedRequestedShipId = requestedShipId?.trim();

    if (!normalizedRequestedShipId) {
      return null;
    }

    const ship = await this.shipsQueryService.findById(normalizedRequestedShipId);

    if (!ship) {
      throw new BadRequestException('Ship not found');
    }

    return ship.id;
  }

  private normalizeLimit(limit?: number): number {
    if (!Number.isInteger(limit)) {
      return DEFAULT_SESSION_LIMIT;
    }

    return Math.min(Math.max(limit ?? DEFAULT_SESSION_LIMIT, 1), 50);
  }

  private parseCursor(cursor?: string | null): number {
    if (!cursor) {
      return 0;
    }

    const parsed = Number.parseInt(cursor, 10);

    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new BadRequestException('Invalid chat session cursor');
    }

    return parsed;
  }

  private escapeLike(value: string): string {
    return value.replace(/[\\%_]/g, (char) => `\\${char}`);
  }

  private normalizeTitle(value?: string | null): string {
    const normalized = value?.trim();
    return normalized ? normalized.slice(0, 255) : DEFAULT_CHAT_TITLE;
  }

  private resolveInitialTitleStatus(title: string): ChatSessionTitleStatus {
    return this.isDefaultTitle(title)
      ? ChatSessionTitleStatus.AUTO_INITIAL
      : ChatSessionTitleStatus.MANUAL;
  }

  private normalizeRequiredTitle(value?: string | null): string {
    const normalized = value?.trim();

    if (!normalized) {
      throw new BadRequestException('Chat title must not be empty');
    }

    return normalized.slice(0, 255);
  }

  private hasGeneratedAutoTitle(title: string | null): boolean {
    return Boolean(title?.trim()) && !this.isDefaultTitle(title);
  }

  private isDefaultTitle(title: string | null): boolean {
    return title?.trim().toLowerCase() === DEFAULT_CHAT_TITLE.toLowerCase();
  }

  private async generateContextualTitle(input: {
    session: ChatSessionEntity;
    messages: ChatMessageEntity[];
    summary: string | null;
    isRefinement: boolean;
  }): Promise<string | null> {
    return this.chatLlmService.completeText({
      systemPrompt: [
        'You create short chat titles for Trident conversations.',
        'The title must describe the broad conversation topic, not copy or paraphrase only the first user question.',
        'Use the conversation language where appropriate.',
        'Return 3 to 7 natural words.',
        'Do not use quotes, trailing punctuation, or generic words like chat or conversation.',
        'Return only the title.',
      ].join(' '),
      userPrompt: [
        `Active ship context: ${this.describeShipContext(input.session)}`,
        `Title stage: ${input.isRefinement ? 'refine existing auto-title' : 'initial temporary title'}`,
        `Current title: ${input.session.title ?? DEFAULT_CHAT_TITLE}`,
        '',
        'Conversation summary:',
        formatConversationSummary(input.summary),
        '',
        'Recent conversation:',
        formatMessageTranscript(input.messages),
      ].join('\n'),
      temperature: 0.2,
      maxTokens: 24,
    });
  }

  private normalizeGeneratedTitle(value: string | null): string | null {
    const normalized = value
      ?.replace(/[\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^["']+|["'.:;!?]+$/g, '')
      .trim();

    if (!normalized || this.isDefaultTitle(normalized)) {
      return null;
    }

    if (normalized.length <= CHAT_TITLE_MAX_LENGTH) {
      return normalized;
    }

    return `${normalized.slice(0, CHAT_TITLE_MAX_LENGTH - 3).trimEnd()}...`;
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

  private async loadMessageCounts(
    sessionIds: string[],
  ): Promise<Map<string, number>> {
    if (sessionIds.length === 0) {
      return new Map();
    }

    const rows = await this.chatMessagesRepository
      .createQueryBuilder('message')
      .select('message.session_id', 'sessionId')
      .addSelect('COUNT(message.id)', 'count')
      .where('message.session_id IN (:...sessionIds)', { sessionIds })
      .andWhere('message.deleted_at IS NULL')
      .groupBy('message.session_id')
      .getRawMany<{ sessionId: string; count: string }>();

    return new Map(
      rows.map((row) => [row.sessionId, Number.parseInt(row.count, 10) || 0]),
    );
  }

  private async countMessages(sessionId: string): Promise<number> {
    return this.chatMessagesRepository.count({
      where: {
        sessionId,
        deletedAt: IsNull(),
      },
    });
  }
}
