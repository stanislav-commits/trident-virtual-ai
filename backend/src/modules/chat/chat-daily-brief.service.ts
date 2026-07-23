import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '../users/entities/user.entity';
import { UserRole } from '../../common/enums/user-role.enum';
import { ShipEntity } from '../ships/entities/ship.entity';
import { AlertEntity } from '../alerts/entities/alert.entity';
import { MetricAnalyzerResponderService } from '../metrics/metric-understanding/metric-analyzer-responder.service';
import { ChatMessageEntity } from './entities/chat-message.entity';
import { ChatMessageRole } from './enums/chat-message-role.enum';
import { ChatSessionEntity } from './entities/chat-session.entity';
import { ChatSessionTitleStatus } from './enums/chat-session-title-status.enum';

/**
 * Proactive morning brief: once a day the assistant WRITES FIRST — a
 * cross-domain snapshot of the vessel delivered into a standing "Morning
 * brief" chat session for every admin user, without anyone asking.
 *
 * Content comes from the same metric-analyzer agent that answers chat
 * questions (night alarms + reserves + PMS due today + position/weather),
 * so its charts / KPI cards / tables ride along exactly like a normal
 * answer (askResults[].data → ragflowContext → chat blocks).
 *
 * Off by default: enable with DAILY_BRIEF_ENABLED=true. Runs at 04:30 UTC
 * (≈ 06:30 ship time in the Med). POST /api/chat-v2/daily-brief/run lets an
 * admin trigger it on demand (also handy for testing).
 */
@Injectable()
export class ChatDailyBriefService {
  private readonly logger = new Logger(ChatDailyBriefService.name);
  /** Serialises manual runs vs the cron so two sweeps never overlap. */
  private running = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly metricAnalyzerResponderService: MetricAnalyzerResponderService,
    @InjectRepository(ChatSessionEntity)
    private readonly sessionRepository: Repository<ChatSessionEntity>,
    @InjectRepository(ChatMessageEntity)
    private readonly messageRepository: Repository<ChatMessageEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(AlertEntity)
    private readonly alertRepository: Repository<AlertEntity>,
  ) {}

  @Cron('0 30 4 * * *')
  async runScheduled(): Promise<void> {
    if (!this.configService.get<boolean>('chat.dailyBriefEnabled', false)) {
      return;
    }
    await this.runForAllShips();
  }

  /** One brief per telemetry-connected vessel, delivered to every admin. */
  async runForAllShips(): Promise<{ ships: number; delivered: number }> {
    if (this.running) {
      this.logger.warn('Daily brief already running — skipping this trigger');
      return { ships: 0, delivered: 0 };
    }
    this.running = true;
    try {
      const ships = await this.shipRepository.find({
        where: { isPlatform: false },
      });
      const connected = ships.filter((s) => s.organizationName);
      let delivered = 0;
      for (const ship of connected) {
        try {
          delivered += await this.runForShip(ship);
        } catch (error) {
          this.logger.error(
            `Daily brief failed for ship ${ship.id}: ${String(error)}`,
          );
        }
      }
      this.logger.log(
        `Daily brief: ${connected.length} ship(s), ${delivered} message(s) delivered`,
      );
      return { ships: connected.length, delivered };
    } finally {
      this.running = false;
    }
  }

  private briefQuestion(): string {
    // The analyzer mirrors the question's language, so the env var flips the
    // whole brief. Default Russian — the crew's chat language today.
    const lang = this.configService.get<string>('chat.dailyBriefLanguage', 'ru');
    if (lang === 'en') {
      return (
        'Morning brief for the crew. Compile a short vessel status report: ' +
        '1) alarms and faults over the last 24 hours (find_active_alarms with include_resolved) — or say the night was quiet; ' +
        '2) current critical reserves — fuel, fresh water, DEF — as ONE render_kpi block, flagging anything low; ' +
        '3) maintenance due today or overdue (get_maintenance_tasks) — only the important ones, max 5; ' +
        '4) current position and whether today\'s weather window is workable (get_vessel_state + get_marine_forecast); ' +
        '5) trend warnings: check 2-3 key running systems (generators, HVAC, tanks) with compare_to_typical / find_unusual_periods over the last 72h and flag anything drifting from its normal range — SKIP this section entirely when all is normal. ' +
        'Start with a one-line verdict (all normal / needs attention: X). Keep it tight — this is a daily digest, not an audit. ' +
        'Write the text as short prose paragraphs and bullet lists ONLY — never markdown |-tables (they are stripped); anything tabular goes through render_table, and the maintenance list belongs in the render_table, not repeated in text. Do NOT write your own big title/header line — the delivery adds a dated header already; start directly with the verdict.'
      );
    }
    return (
      'Утренний брифинг для экипажа. Составь короткую сводку по судну: ' +
      '1) алармы и неисправности за последние 24 часа (find_active_alarms с include_resolved) — либо скажи, что ночь прошла спокойно; ' +
      '2) текущие критические запасы — топливо, пресная вода, DEF — одним блоком render_kpi, отметь низкие; ' +
      '3) задачи ТО на сегодня и просроченные (get_maintenance_tasks) — только важные, максимум 5; ' +
      '4) текущая позиция и пригодно ли сегодняшнее погодное окно (get_vessel_state + get_marine_forecast); ' +
      '5) тренд-предупреждения: проверь 2-3 ключевые работающие системы (генераторы, климат, танки) через compare_to_typical / find_unusual_periods за последние 72 часа и отметь, что уходит от своей нормы — если всё в норме, ПРОПУСТИ эту секцию целиком. ' +
      'Начни с вердикта одной строкой (всё в норме / требует внимания: X). Кратко — это ежедневный дайджест, не аудит. ' +
      'Текст пиши только короткими абзацами и маркированными списками — НИКАКИХ markdown-таблиц через | (они вырезаются); всё табличное — только через render_table, и список задач ТО живёт в render_table, не дублируй его текстом. НЕ пиши свой большой заголовок — датированный заголовок уже добавляется при доставке; начинай сразу с вердикта.'
    );
  }

  private async runForShip(ship: ShipEntity): Promise<number> {
    const result = await this.metricAnalyzerResponderService.answer(
      ship.id,
      this.briefQuestion(),
    );

    // Same shape the chat responder produces, so MessageBubble renders the
    // brief's charts/KPI/tables exactly like a normal assistant answer.
    const ragflowContext = {
      askResults: [
        {
          askId: 'daily-brief',
          intent: 'live_metrics',
          responder: 'metrics',
          question: 'daily brief',
          capabilityEnabled: true,
          capabilityLabel: 'daily brief',
          summary: result.answer,
          data: {
            status: 'ok',
            charts: result.charts,
            maps: result.maps,
            tables: result.tables,
            kpis: result.kpis,
          },
        },
      ],
    };

    const admins = await this.userRepository.find({
      where: { role: UserRole.ADMIN },
    });
    let delivered = 0;
    for (const admin of admins) {
      const session = await this.findOrCreateBriefSession(admin.id, ship.id);
      await this.messageRepository.save(
        this.messageRepository.create({
          sessionId: session.id,
          role: ChatMessageRole.ASSISTANT,
          content: this.datedHeader() + result.answer,
          ragflowContext,
        }),
      );
      session.updatedAt = new Date();
      await this.sessionRepository.save(session);
      delivered += 1;
    }
    await this.upsertBriefNotification(ship.id, result.answer);
    return delivered;
  }

  /**
   * Surfaces the brief in the bell "Notifications" panel: one info-severity
   * entry per ship per day (fingerprint-deduped), active until the crew
   * acknowledges it — an unread brief is exactly an unread notification.
   * The panel entry carries the verdict; the full brief with its KPI/table
   * blocks lives in the "Утренний брифинг" chat session.
   */
  private async upsertBriefNotification(
    shipId: string,
    answer: string,
  ): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const fingerprint = `daily-brief-${shipId}-${today}`;
    const existing = await this.alertRepository.findOne({
      where: { fingerprint, source: 'daily_brief' },
    });
    // The verdict is steered to be the first non-empty line of the brief.
    const verdict =
      answer
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))[0]
        ?.replace(/\*\*/g, '')
        .slice(0, 500) ?? 'Утренний брифинг готов.';
    const message =
      verdict + '\n\nПолный брифинг — в чате «Утренний брифинг».';
    const now = new Date();
    if (existing) {
      existing.message = message;
      existing.lastSeenAt = now;
      await this.alertRepository.save(existing);
      return;
    }
    await this.alertRepository.save(
      this.alertRepository.create({
        shipId,
        source: 'daily_brief',
        ruleName: 'daily-brief',
        severity: 'info',
        status: 'firing',
        title: `Утренний брифинг — ${today}`,
        message,
        fingerprint,
        startedAt: now,
        lastSeenAt: now,
      }),
    );
  }

  private datedHeader(): string {
    const today = new Date().toISOString().slice(0, 10);
    return `**Утренний брифинг — ${today}**\n\n`;
  }

  private static readonly BRIEF_TITLE = 'Утренний брифинг';

  private async findOrCreateBriefSession(
    userId: string,
    shipId: string,
  ): Promise<ChatSessionEntity> {
    const existing = await this.sessionRepository.findOne({
      where: {
        userId,
        shipId,
        title: ChatDailyBriefService.BRIEF_TITLE,
      },
      order: { createdAt: 'DESC' },
    });
    if (existing && !existing.deletedAt) {
      return existing;
    }
    return this.sessionRepository.save(
      this.sessionRepository.create({
        userId,
        shipId,
        title: ChatDailyBriefService.BRIEF_TITLE,
        // Manual title: the auto-titler must never rename the standing
        // brief session based on its content.
        titleStatus: ChatSessionTitleStatus.MANUAL,
      }),
    );
  }
}
