import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { withLlmUsageContext } from '../llm-usage/llm-usage.context';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ShipEntity } from '../ships/entities/ship.entity';
import { AlertEntity } from '../alerts/entities/alert.entity';
import { MetricAnalyzerResponderService } from '../metrics/metric-understanding/metric-analyzer-responder.service';
import { ChatMessageEntity } from './entities/chat-message.entity';
import { ChatMessageRole } from './enums/chat-message-role.enum';
import { ChatSessionEntity } from './entities/chat-session.entity';
import { ChatSessionTitleStatus } from './enums/chat-session-title-status.enum';
import { PmsService } from '../pms/pms.service';

/**
 * Morning brief — announced by the schedule, written only when asked for.
 *
 * The cron does NOT call a model. At 04:30 UTC it reads the alarm log and the
 * task list and posts one notification saying what actually happened overnight
 * in a couple of deterministic sentences. Nothing is generated, nothing is
 * delivered into a chat, and no tokens are spent on a brief nobody has asked
 * to read.
 *
 * The full write-up — the cross-domain analysis with its KPI cards, tables and
 * charts — is produced by generateForShip() when the crew presses the button
 * on that notification. That run bills to the person who pressed it, which is
 * also what makes the spend legible on the Overview page: a brief someone read
 * is crew chat, not unattributable platform upkeep.
 *
 * Off by default: enable with DAILY_BRIEF_ENABLED=true. Runs at 04:30 UTC
 * (≈ 06:30 ship time in the Med).
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
    @InjectRepository(AlertEntity)
    private readonly alertRepository: Repository<AlertEntity>,
    private readonly pmsService: PmsService,
  ) {}

  @Cron('0 30 4 * * *')
  async runScheduled(): Promise<void> {
    if (!this.configService.get<boolean>('chat.dailyBriefEnabled', false)) {
      return;
    }
    await this.announceForAllShips();
  }

  /**
   * The scheduled half: one notification per vessel, no model involved.
   */
  async announceForAllShips(): Promise<{ ships: number; announced: number }> {
    if (this.running) {
      this.logger.warn('Daily brief already running — skipping this trigger');
      return { ships: 0, announced: 0 };
    }
    this.running = true;
    try {
      const ships = await this.shipRepository.find({
        where: { isPlatform: false },
      });
      const connected = ships.filter((s) => s.organizationName);
      let announced = 0;
      for (const ship of connected) {
        try {
          await this.announceForShip(ship.id);
          announced += 1;
        } catch (error) {
          this.logger.error(
            `Daily brief announcement failed for ship ${ship.id}: ${String(error)}`,
          );
        }
      }
      this.logger.log(
        `Daily brief: announced for ${announced}/${connected.length} ship(s) — no tokens spent`,
      );
      return { ships: connected.length, announced };
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
   * The couple of sentences that go in the notification, counted rather than
   * written: alarms since yesterday and the state of the task list.
   *
   * Deterministic on purpose. This runs for every vessel every morning whether
   * or not anyone opens it, so it must not cost a model call — and a headline
   * that is counted cannot hallucinate. Anything that needs judgement waits
   * for the full brief.
   */
  private async announcementText(shipId: string): Promise<string> {
    const isRu = this.lang() === 'ru';
    const since = new Date(Date.now() - 24 * 3_600_000);
    const alerts = await this.alertRepository
      .createQueryBuilder('a')
      .where('a.shipId = :shipId', { shipId })
      .andWhere('a.source != :daily', { daily: 'daily_brief' })
      .andWhere('(a.startedAt >= :since OR a.resolvedAt >= :since)', { since })
      .orderBy('a.startedAt', 'DESC')
      .getMany();

    const critical = alerts.filter(
      (a) => a.severity === 'critical' || a.severity === 'high',
    );
    const stillFiring = alerts.filter((a) => a.status !== 'resolved');

    const parts: string[] = [];
    if (alerts.length === 0) {
      parts.push(isRu ? 'Ночь прошла спокойно, тревог нет.' : 'A quiet night — no alarms.');
    } else {
      const worst = critical[0] ?? alerts[0];
      const head = isRu
        ? `${alerts.length} ${this.plural(alerts.length, 'тревога', 'тревоги', 'тревог')} за сутки`
        : `${alerts.length} alarm${alerts.length === 1 ? '' : 's'} in the last 24h`;
      const detail = isRu
        ? `${critical.length ? `${critical.length} важных, ` : ''}${stillFiring.length} не сброшено. Самая свежая: ${worst.title}.`
        : `${critical.length ? `${critical.length} serious, ` : ''}${stillFiring.length} still active. Latest: ${worst.title}.`;
      parts.push(`${head} — ${detail}`);
    }

    const tasks = await this.pmsService.list(shipId);
    const overdue = tasks.filter((t) => t.status === 'overdue');
    const dueSoon = tasks.filter((t) => t.status === 'due-soon');
    if (overdue.length || dueSoon.length) {
      parts.push(
        isRu
          ? `По обслуживанию: ${overdue.length} просрочено, ${dueSoon.length} на подходе${overdue[0] ? ` (например, «${overdue[0].task}»)` : ''}.`
          : `Maintenance: ${overdue.length} overdue, ${dueSoon.length} coming up${overdue[0] ? ` (e.g. "${overdue[0].task}")` : ''}.`,
      );
    } else {
      parts.push(
        isRu ? 'Просроченных работ нет.' : 'Nothing overdue on the task list.',
      );
    }

    return parts.join(' ');
  }

  /** Russian needs three forms; the count decides which. */
  private plural(n: number, one: string, few: string, many: string): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
    return many;
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
      'Write the text as short prose paragraphs and bullet lists ONLY — never markdown |-tables (they are stripped); anything tabular goes through render_table, and the maintenance list belongs in the render_table, not repeated in text. Do NOT write your own big title/header line — the delivery adds a dated header already; start directly with the verdict. ' +
      // Only the LAST message of the run is kept — text written between tool
      // calls is discarded as preamble. Writing sections 1-3, then calling
      // get_vessel_state for section 4, cost exactly that: the 2026-07-31
      // brief reached the crew starting mid-sentence at "4 — Position &
      // weather". Every section must be written once, at the end.
      'IMPORTANT — write NOTHING until you have finished every tool call you need. ' +
      'Make all your calls first, then write the complete brief, all five sections in order, as your single final message. ' +
      'Prose written between tool calls is discarded and the crew receives a brief that starts in the middle.'
    );
  }

  /**
   * Write the full brief for one vessel and put it in the reader's own brief
   * session. Called from the button on the notification, never from the cron.
   *
   * Billed to `userId`: the run happens because a person asked for it, and the
   * Overview page should say so rather than filing it under automation.
   */
  async generateForShip(
    shipId: string,
    userId: string,
  ): Promise<{ sessionId: string }> {
    const ship = await this.shipRepository.findOne({ where: { id: shipId } });
    if (!ship) {
      throw new NotFoundException(`Ship ${shipId} not found`);
    }
    const alarmsGroundTruth = await this.alarmsLast24h(ship.id);
    const result = await withLlmUsageContext(
      { shipId: ship.id, userId, purpose: 'daily_brief' },
      () =>
        this.metricAnalyzerResponderService.answer(
          ship.id,
          this.briefQuestion(alarmsGroundTruth),
          { answerLanguage: this.lang(), readOnly: true },
        ),
    );

    const answer = this.assembleBrief(result.answer, result.intermediateText);

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
          summary: answer,
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

    // Only the reader's own session. Writing the same brief into every
    // admin's chat was how one person's request became everyone's unread
    // message; whoever else wants it presses their own button.
    const session = await this.findOrCreateBriefSession(userId, ship.id);
    await this.messageRepository.save(
      this.messageRepository.create({
        sessionId: session.id,
        role: ChatMessageRole.ASSISTANT,
        content: this.datedHeader() + answer,
        ragflowContext,
      }),
    );
    session.updatedAt = new Date();
    await this.sessionRepository.save(session);

    // The notification stays, now pointing at a brief that exists.
    await this.markBriefGenerated(ship.id);
    return { sessionId: session.id };
  }


  /**
   * Put the brief back together when the model wrote it in instalments.
   *
   * The analyzer keeps only the last message of a run — text written between
   * tool calls is narration for a chat answer. A five-section report is not:
   * on 2026-07-31 the crew got a brief that opened mid-sentence at "4 —
   * Position & weather" because sections 1-3 were written before the model
   * called get_vessel_state.
   *
   * The final message wins whenever it already covers the report (it opens
   * with the verdict or carries section 1), so a model that behaves and writes
   * everything at the end is never duplicated. Otherwise the instalments are
   * stitched in front of it, dropping any that the final message repeats.
   */
  private assembleBrief(finalAnswer: string, instalments: string[]): string {
    const opensTheReport = (text: string): boolean =>
      /(^|\n)\s*\*{0,2}1\s*[—–-]/.test(text) ||
      /^\s*\*{0,2}(needs attention|all normal|требует внимания|всё в норме|все в норме)/i.test(
        text.trim(),
      );
    if (!instalments.length || opensTheReport(finalAnswer)) return finalAnswer;

    const kept = instalments.filter(
      (part) => part.length > 40 && !finalAnswer.includes(part.slice(0, 60)),
    );
    if (!kept.length) return finalAnswer;
    this.logger.warn(
      `Brief arrived in ${kept.length + 1} instalments — stitching, the final message alone would have started mid-report`,
    );
    return [...kept, finalAnswer].join('\n\n');
  }

  private briefTitle(): string {
    return this.lang() === 'ru' ? 'Утренний брифинг' : 'Morning Brief';
  }

  /**
   * The morning's entry in the bell panel: what happened overnight, counted,
   * plus the offer to write the full brief.
   *
   * `ruleName` doubles as the state flag the UI reads — `daily-brief-pending`
   * until someone generates it, `daily-brief` afterwards — so the button knows
   * whether it is offering work or pointing at a brief already written.
   */
  private async announceForShip(shipId: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const fingerprint = `daily-brief-${shipId}-${today}`;
    const isRu = this.lang() === 'ru';
    const headline = await this.announcementText(shipId);
    const message =
      headline +
      (isRu
        ? '\n\nПолный брифинг будет собран, когда вы его откроете.'
        : '\n\nThe full brief is written when you ask for it.');
    const now = new Date();
    const existing = await this.alertRepository.findOne({
      where: { fingerprint, source: 'daily_brief' },
    });
    if (existing) {
      // Never downgrade a brief that has already been written back to pending.
      if (existing.ruleName === 'daily-brief-pending') {
        existing.message = message;
      }
      existing.lastSeenAt = now;
      await this.alertRepository.save(existing);
      return;
    }
    await this.alertRepository.save(
      this.alertRepository.create({
        shipId,
        source: 'daily_brief',
        ruleName: 'daily-brief-pending',
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

  /** Flip today's notification from "offer" to "written" after a generation. */
  private async markBriefGenerated(shipId: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const existing = await this.alertRepository.findOne({
      where: { fingerprint: `daily-brief-${shipId}-${today}`, source: 'daily_brief' },
    });
    if (!existing) return;
    existing.ruleName = 'daily-brief';
    existing.lastSeenAt = new Date();
    await this.alertRepository.save(existing);
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
