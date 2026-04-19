import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { ShipsQueryService } from '../ships/ships-query.service';
import { toChatSessionResponse } from './chat.mapper';
import { CreateChatSessionDto } from './dto/create-chat-session.dto';
import { ListChatSessionsQueryDto } from './dto/list-chat-sessions-query.dto';
import { SetChatSessionPinDto } from './dto/set-chat-session-pin.dto';
import { UpdateChatSessionDto } from './dto/update-chat-session.dto';
import { ChatMessageEntity } from './entities/chat-message.entity';
import { ChatSessionEntity } from './entities/chat-session.entity';

const DEFAULT_CHAT_TITLE = 'New Chat';
const DEFAULT_SESSION_LIMIT = 20;

@Injectable()
export class ChatSessionsService {
  constructor(
    @InjectRepository(ChatSessionEntity)
    private readonly chatSessionsRepository: Repository<ChatSessionEntity>,
    @InjectRepository(ChatMessageEntity)
    private readonly chatMessagesRepository: Repository<ChatMessageEntity>,
    private readonly shipsQueryService: ShipsQueryService,
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
    const entity = this.chatSessionsRepository.create({
      title: this.normalizeTitle(input.title),
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

  async applyUserMessageActivity(
    sessionId: string,
    content: string,
  ): Promise<void> {
    const session = await this.chatSessionsRepository.findOne({
      where: {
        id: sessionId,
        deletedAt: IsNull(),
      },
    });

    if (!session) {
      return;
    }

    if (this.shouldDeriveTitle(session.title)) {
      session.title = this.deriveTitleFromMessage(content);
    }

    session.updatedAt = new Date();
    await this.chatSessionsRepository.save(session);
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

  private normalizeRequiredTitle(value?: string | null): string {
    const normalized = value?.trim();

    if (!normalized) {
      throw new BadRequestException('Chat title must not be empty');
    }

    return normalized.slice(0, 255);
  }

  private shouldDeriveTitle(title: string | null): boolean {
    if (!title) {
      return true;
    }

    return title.trim().toLowerCase() === DEFAULT_CHAT_TITLE.toLowerCase();
  }

  private deriveTitleFromMessage(content: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim();

    if (!normalized) {
      return DEFAULT_CHAT_TITLE;
    }

    if (normalized.length <= 80) {
      return normalized;
    }

    return `${normalized.slice(0, 79).trimEnd()}...`;
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
