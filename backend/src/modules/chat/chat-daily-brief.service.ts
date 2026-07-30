import { Injectable, Logger } from '@nestjs/common';
import { withLlmUsageContext } from '../llm-usage/llm-usage.context';
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

  private lang(): string {
    // The whole interface is English; the assistant only happens to be
    // spoken to in Russian in some sessions. Default English throughout —
    // DAILY_BRIEF_LANGUAGE=ru switches the brief (not the rest of the UI).
    return this.configService.get<string>('chat.dailyBriefLanguage', 'en');
  }

  /**
   * Ground-truth alarm log for the last 24h, straight from the `alerts`
   * table — the same source of truth the Notifications bell reads. The
   * brief previously asked the LLM to re-derive alarms itself via the
   * find_active_alarms tool (which scans raw Influx field names for a
   * fault/warning/alarm regex and defaults to active-only), so a real
   * Grafana-fired-and-resolved alert could be entirely missed. Handing the
   * model a deterministic list removes that guesswork.
   */
  private async alarmsLast24h(shipId: string): Promise<string> {
    const since = new Date(Date.now() - 24 * 3_600_000);
    const alerts = await this.alertRepository
      .createQueryBuilder('a')
      .where('a.shipId = :shipId', { shipId })
      .andWhere('a.source != :daily', { daily: 'daily_brief' })
      .andWhere('(a.startedAt >= :since OR a.resolvedAt >= :since)', {
        since,
      })
      .orderBy('a.startedAt', 'DESC')
      .getMany();

    if (alerts.length === 0) {
      return 'Ground truth from the alerts system: no alarms recorded in the last 24 hours.';
    }
    const lines = alerts.map((a) => {
      const status = a.status === 'resolved' ? 'resolved' : 'firing';
      return `- [${a.severity}/${status}] ${a.title}${a.message ? ` — ${a.message}` : ''} (started ${a.startedAt.toISOString()}${a.resolvedAt ? `, resolved ${a.resolvedAt.toISOString()}` : ''})`;
    });
    const header = `Ground truth from the alerts system — ${alerts.length} alarm(s) in the last 24 hours:`;
    return [header, ...lines].join('\n');
  }

  /**
   * The prompt is ALWAYS English — prompts must never be written in another
   * language (Russian wording inside prompts dragged the model's answers into
   * Russian on English conversations). The OUTPUT language is set separately,
   * via the analyzer's answerLanguage option.
   */
  private briefQuestion(alarmsGroundTruth: string): string {
    return (
      'Morning brief for the crew. Compile a short vessel status report: ' +
        `1) alarms and faults over the last 24 hours — use this authoritative list, do not re-derive it yourself:\n${alarmsGroundTruth}\n` +
      'Summarize it in your own words (or say the night was quiet if it is empty) — do not call find_active_alarms, this list is already ground truth; ' +
      '2) current critical reserves — fuel, fresh water, DEF — as ONE render_kpi block, flagging anything low; ' +
      '3) maintenance due today or overdue (get_maintenance_tasks) — only the important ones, max 5; ' +
      '4) current position and whether today\'s weather window is workable (get_vessel_state + get_marine_forecast); ' +
      '5) trend warnings: check 2-3 key running systems (generators, HVAC, tanks) with compare_to_typical / find_unusual_periods over the last 72h and flag anything drifting from its normal range — SKIP this section entirely when all is normal. ' +
      'Start with a one-line verdict (all normal / needs attention: X). Keep it tight — this is a daily digest, not an audit. ' +
      'Write the text as short prose paragraphs and bullet lists ONLY — never markdown |-tables (they are stripped); anything tabular goes through render_table, and the maintenance list belongs in the render_table, not repeated in text. Do NOT write your own big title/header line — the delivery adds a dated header already; start directly with the verdict.'
    );
  }

  private async runForShip(ship: ShipEntity): Promise<number> {
    const alarmsGroundTruth = await this.alarmsLast24h(ship.id);
    const result = await withLlmUsageContext(
      { shipId: ship.id, purpose: 'daily_brief' },
      () =>
        this.metricAnalyzerResponderService.answer(
          ship.id,
          this.briefQuestion(alarmsGroundTruth),
          { answerLanguage: this.lang() },
        ),
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

  private briefTitle(): string {
    return this.lang() === 'ru' ? 'Утренний брифинг' : 'Morning Brief';
  }

  /**
   * Surfaces the brief in the bell "Notifications" panel: one info-severity
   * entry per ship per day (fingerprint-deduped), active until the crew
   * acknowledges it — an unread brief is exactly an unread notification.
   * The panel entry carries the verdict; the full brief with its KPI/table
   * blocks lives in the brief chat session (see briefTitle()).
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
    const isRu = this.lang() === 'ru';
    // The verdict is steered to be the first non-empty line of the brief.
    const verdict =
      answer
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))[0]
        ?.replace(/\*\*/g, '')
        .slice(0, 500) ??
      (isRu ? 'Утренний брифинг готов.' : 'Morning brief is ready.');
    const message =
      verdict +
      (isRu
        ? `\n\nПолный брифинг — в чате «${this.briefTitle()}».`
        : `\n\nFull brief in the "${this.briefTitle()}" chat.`);
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
        title: `${this.briefTitle()} — ${today}`,
        message,
        fingerprint,
        startedAt: now,
        lastSeenAt: now,
      }),
    );
  }

  private datedHeader(): string {
    const today = new Date().toISOString().slice(0, 10);
    return `**${this.briefTitle()} — ${today}**\n\n`;
  }

  private async findOrCreateBriefSession(
    userId: string,
    shipId: string,
  ): Promise<ChatSessionEntity> {
    const title = this.briefTitle();
    const existing = await this.sessionRepository.findOne({
      where: { userId, shipId, title },
      order: { createdAt: 'DESC' },
    });
    if (existing && !existing.deletedAt) {
      return existing;
    }
    return this.sessionRepository.save(
      this.sessionRepository.create({
        userId,
        shipId,
        title,
        // Manual title: the auto-titler must never rename the standing
        // brief session based on its content.
        titleStatus: ChatSessionTitleStatus.MANUAL,
      }),
    );
  }
}
