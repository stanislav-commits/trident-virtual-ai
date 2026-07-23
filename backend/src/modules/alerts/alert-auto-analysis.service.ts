import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { MoreThan, Not, IsNull, Repository } from 'typeorm';
import { MetricAnalyzerResponderService } from '../metrics/metric-understanding/metric-analyzer-responder.service';
import { AlertEntity } from './entities/alert.entity';

/**
 * Proactive alarm root-cause analysis: when a critical/high metric alarm
 * fires, the same metric-analyzer agent that answers chat questions
 * investigates it automatically — trend around the trigger, correlated
 * metrics, recurrence history — and the result is stored on the alert and
 * shown in the Notifications panel. The crew opens the alarm and the
 * analysis is already there, instead of clicking "Ask AI" and waiting.
 *
 * Cost-gated: ALERT_AUTO_ANALYZE_SEVERITY (default "critical,high"; "off"
 * disables) + a per-rule cooldown so a flapping rule doesn't re-run the
 * analyzer every few minutes.
 */
@Injectable()
export class AlertAutoAnalysisService {
  private readonly logger = new Logger(AlertAutoAnalysisService.name);
  private static readonly RULE_COOLDOWN_MS = 6 * 3600 * 1000;

  constructor(
    private readonly configService: ConfigService,
    private readonly metricAnalyzerResponderService: MetricAnalyzerResponderService,
    @InjectRepository(AlertEntity)
    private readonly alertRepository: Repository<AlertEntity>,
  ) {}

  private analyzedSeverities(): Set<string> {
    const raw = this.configService.get<string>(
      'alerts.autoAnalyzeSeverity',
      'critical,high',
    );
    if (!raw || raw.trim().toLowerCase() === 'off') return new Set();
    return new Set(
      raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
  }

  /** Fire-and-forget from the webhook path — must never throw upstream. */
  maybeAnalyze(alert: AlertEntity): void {
    void this.analyze(alert).catch((error) => {
      this.logger.warn(
        `Auto-analysis failed for alert ${alert.id}: ${String(error)}`,
      );
    });
  }

  private async analyze(alert: AlertEntity): Promise<void> {
    if (!alert.shipId || alert.source !== 'metric') return;
    if (!this.analyzedSeverities().has(alert.severity)) return;

    // Cooldown: if this rule already got an analysis recently, a re-fire of
    // the same condition adds nothing but cost.
    const recent = await this.alertRepository.findOne({
      where: {
        ruleName: alert.ruleName,
        aiAnalyzedAt: MoreThan(
          new Date(Date.now() - AlertAutoAnalysisService.RULE_COOLDOWN_MS),
        ),
        id: Not(alert.id),
        aiAnalysis: Not(IsNull()),
      },
    });
    if (recent) {
      this.logger.log(
        `Skipping auto-analysis for "${alert.ruleName}" — analyzed ${recent.aiAnalyzedAt?.toISOString()} (cooldown)`,
      );
      return;
    }

    const lang = this.configService.get<string>('chat.dailyBriefLanguage', 'en');
    const when = alert.startedAt.toISOString();
    const valuePart = alert.value != null ? ` value=${alert.value}` : '';
    const question =
      lang === 'ru'
        ? `Аларм «${alert.title}» (severity ${alert.severity}) сработал в ${when}${valuePart}. ` +
          'Разберись в вероятной причине (тренд метрики вокруг срабатывания, связанные метрики, состояние оборудования, повторялся ли аларм раньше), но ОТВЕТЬ РОВНО ДВУМЯ КОРОТКИМИ СТРОКАМИ в этом формате, без заголовков, без markdown, без пояснений сверху: ' +
          '"Cause: <одно предложение, самая вероятная причина>" затем с новой строки "Immediate action: <одно предложение, что сделать прямо сейчас>". Это компактная аннотация для панели уведомлений, а не отчёт — если не уверен в причине, так и напиши коротко ("Cause: unclear, needs manual check"). Только текст: без вызовов render_chart/render_table/render_kpi.'
        : `Alarm "${alert.title}" (severity ${alert.severity}) fired at ${when}${valuePart}. ` +
          'Investigate the likely cause (this metric\'s trend around the trigger, correlated metrics, equipment state, whether it has fired before), but ANSWER IN EXACTLY TWO SHORT LINES in this format, no headers, no markdown, no preamble: ' +
          '"Cause: <one sentence, the most likely cause>" then on a new line "Immediate action: <one sentence, what to do right now>". This is a compact Notifications-panel annotation, not a report — if unsure of the cause, say so briefly ("Cause: unclear, needs manual check"). Text only: no render_chart/render_table/render_kpi calls.';

    this.logger.log(
      `Auto-analyzing alert "${alert.ruleName}" (${alert.severity}) for ship ${alert.shipId}`,
    );
    const result = await this.metricAnalyzerResponderService.answer(
      alert.shipId,
      question,
    );

    // Re-read: the alert may have resolved/updated while the analyzer ran.
    const fresh = await this.alertRepository.findOne({
      where: { id: alert.id },
    });
    if (!fresh) return;
    fresh.aiAnalysis = this.clampAnalysis(result.answer);
    fresh.aiAnalyzedAt = new Date();
    await this.alertRepository.save(fresh);
    this.logger.log(
      `Auto-analysis stored for alert ${alert.id} (${result.durationMs} ms, ~$${result.estimatedCostUsd})`,
    );
  }

  /**
   * Deterministic length guard — the prompt asks for two short lines, but an
   * LLM's compliance with a length instruction isn't guaranteed (the same
   * lesson as stripDuplicateMarkdownTables for render_table/kpi). Clamps
   * "Cause" and "Immediate action" INDEPENDENTLY so a model that runs on for
   * the cause can never push the action line out entirely — a whole-text cut
   * did exactly that in testing (one long "Cause" sentence ate the full
   * budget and the panel never showed an action at all).
   */
  private clampAnalysis(text: string): string {
    const max = this.configService.get<number>('alerts.autoAnalyzeMaxChars', 420);
    const perLineMax = Math.max(60, Math.floor(max / 2) - 20);
    const parsed = this.parseCauseAction(text);
    if (parsed) {
      return (
        `Cause: ${this.clampSentence(parsed.cause, perLineMax)}\n` +
        `Immediate action: ${this.clampSentence(parsed.action, perLineMax)}`
      );
    }
    // Unrecognized shape (model ignored the two-line format) — clamp the
    // whole thing as a single block so the panel still stays short.
    return this.clampSentence(text.trim(), max);
  }

  private parseCauseAction(
    text: string,
  ): { cause: string; action: string } | null {
    const causeMatch = text.match(
      /Cause:\s*([\s\S]*?)(?=\n\s*Immediate action:|$)/i,
    );
    const actionMatch = text.match(/Immediate action:\s*([\s\S]*)/i);
    if (!causeMatch && !actionMatch) return null;
    return {
      cause: (causeMatch?.[1] ?? '').trim(),
      action: (actionMatch?.[1] ?? '').trim(),
    };
  }

  private clampSentence(s: string, max: number): string {
    const trimmed = s.trim();
    if (trimmed.length <= max) return trimmed;
    const cut = trimmed.slice(0, max);
    const lastBreak = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf(', '),
      cut.lastIndexOf(' — '),
      cut.lastIndexOf('\n'),
    );
    return (lastBreak > max * 0.4 ? cut.slice(0, lastBreak) : cut).trim() + '…';
  }
}
