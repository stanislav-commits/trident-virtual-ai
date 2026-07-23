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

    const lang = this.configService.get<string>('chat.dailyBriefLanguage', 'ru');
    const when = alert.startedAt.toISOString();
    const valuePart = alert.value != null ? ` value=${alert.value}` : '';
    const question =
      lang === 'en'
        ? `Alarm "${alert.title}" (severity ${alert.severity}) fired at ${when}${valuePart}. ` +
          'Investigate the likely cause: examine this metric\'s trend around the trigger time, check correlated metrics and equipment state in that window, and whether this alarm has fired before recently (recurrence). Conclude with the most likely cause and a recommended action. Be concise — this is an automatic alarm annotation, not a full report. Text only: no render_chart/render_table/render_kpi calls.'
        : `Аларм «${alert.title}» (severity ${alert.severity}) сработал в ${when}${valuePart}. ` +
          'Разберись в вероятной причине: посмотри тренд этой метрики вокруг срабатывания, проверь связанные метрики и состояние оборудования в этом окне, и повторялся ли этот аларм в последнее время. Заверши наиболее вероятной причиной и рекомендуемым действием. Кратко — это автоматическая аннотация к аларму, не полный отчёт. Только текст: без вызовов render_chart/render_table/render_kpi.';

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
    fresh.aiAnalysis = result.answer;
    fresh.aiAnalyzedAt = new Date();
    await this.alertRepository.save(fresh);
    this.logger.log(
      `Auto-analysis stored for alert ${alert.id} (${result.durationMs} ms, ~$${result.estimatedCostUsd})`,
    );
  }
}
