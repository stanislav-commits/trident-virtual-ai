import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InfluxService } from '../../integrations/influx/influx.service';
import { AlertEntity } from '../alerts/entities/alert.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { MetricWatchEntity } from './entities/metric-watch.entity';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';

/**
 * Evaluates crew-created metric watches every 5 minutes: reads the metric's
 * latest value, compares against the watch threshold (display units), and on
 * an ok→triggered edge writes a Notifications-panel entry (alerts row,
 * source 'watch'). When the value recovers, the entry auto-resolves and the
 * watch re-arms. Pure Influx reads — no LLM cost; a handful of quick queries
 * only while active watches exist.
 */
@Injectable()
export class MetricWatchCheckerService {
  private readonly logger = new Logger(MetricWatchCheckerService.name);
  private running = false;

  constructor(
    private readonly influxService: InfluxService,
    @InjectRepository(MetricWatchEntity)
    private readonly watchRepository: Repository<MetricWatchEntity>,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly catalogRepository: Repository<ShipMetricCatalogEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    @InjectRepository(AlertEntity)
    private readonly alertRepository: Repository<AlertEntity>,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkAll(): Promise<{ checked: number; triggered: number }> {
    if (this.running) return { checked: 0, triggered: 0 };
    this.running = true;
    try {
      const watches = await this.watchRepository.find({
        where: { isActive: true },
      });
      if (watches.length === 0) return { checked: 0, triggered: 0 };

      let triggered = 0;
      for (const watch of watches) {
        try {
          if (await this.checkOne(watch)) triggered += 1;
        } catch (error) {
          this.logger.warn(
            `Watch ${watch.id} ("${watch.label}") check failed: ${String(error)}`,
          );
        }
      }
      if (triggered > 0) {
        this.logger.log(
          `Watch sweep: ${watches.length} checked, ${triggered} newly triggered`,
        );
      }
      return { checked: watches.length, triggered };
    } finally {
      this.running = false;
    }
  }

  /** Returns true when this check newly triggered the watch. */
  private async checkOne(watch: MetricWatchEntity): Promise<boolean> {
    const metric = await this.catalogRepository.findOne({
      where: { id: watch.metricCatalogId },
    });
    if (!metric) {
      // Metric vanished from the catalog — deactivate rather than fail forever.
      watch.isActive = false;
      await this.watchRepository.save(watch);
      return false;
    }
    const ship = await this.shipRepository.findOne({
      where: { id: watch.shipId },
    });
    if (!ship?.organizationName) return false;

    const sample = await this.influxService.queryMetricRange(
      ship.organizationName,
      {
        bucket: metric.bucket,
        measurement: metric.key.split('::')[1] ?? metric.bucket,
        field: metric.field,
      },
      new Date(Date.now() - 30 * 60 * 1000),
      new Date(),
      'last',
    );
    const raw = sample?.value;
    if (raw == null || !Number.isFinite(Number(raw))) return false;
    const sf =
      typeof metric.scaleFactor === 'number' &&
      Number.isFinite(Number(metric.scaleFactor)) &&
      Number(metric.scaleFactor) !== 0
        ? Number(metric.scaleFactor)
        : 1;
    const value = Number(raw) * sf;

    const violated =
      watch.condition === 'above' ? value > watch.threshold : value < watch.threshold;

    watch.lastValue = value;
    watch.lastCheckedAt = new Date();

    let newlyTriggered = false;
    if (violated && watch.state !== 'triggered') {
      watch.state = 'triggered';
      watch.triggeredAt = new Date();
      await this.upsertWatchNotification(watch, value);
      newlyTriggered = true;
    } else if (!violated && watch.state === 'triggered') {
      watch.state = 'ok';
      await this.resolveWatchNotification(watch);
    }
    await this.watchRepository.save(watch);
    return newlyTriggered;
  }

  private fmt(v: number): string {
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  private async upsertWatchNotification(
    watch: MetricWatchEntity,
    value: number,
  ): Promise<void> {
    const unit = watch.unit ? ` ${watch.unit}` : '';
    const dir = watch.condition === 'above' ? 'above' : 'below';
    const message =
      `${watch.label}: current ${this.fmt(value)}${unit} — ${dir} the watch threshold of ` +
      `${this.fmt(watch.threshold)}${unit}. Watch stays armed and auto-clears when the value recovers.`;
    const fingerprint = `watch-${watch.id}`;
    const now = new Date();
    const existing = await this.alertRepository.findOne({
      where: { fingerprint, status: 'firing' },
    });
    if (existing) {
      existing.message = message;
      existing.value = value;
      existing.lastSeenAt = now;
      await this.alertRepository.save(existing);
      return;
    }
    await this.alertRepository.save(
      this.alertRepository.create({
        shipId: watch.shipId,
        source: 'watch',
        ruleName: `watch:${watch.label}`.slice(0, 255),
        severity: 'warning',
        status: 'firing',
        value,
        title: `Watch triggered: ${watch.label}`.slice(0, 300),
        message,
        fingerprint,
        startedAt: now,
        lastSeenAt: now,
      }),
    );
  }

  private async resolveWatchNotification(watch: MetricWatchEntity): Promise<void> {
    const active = await this.alertRepository.findOne({
      where: { fingerprint: `watch-${watch.id}`, status: 'firing' },
    });
    if (active) {
      active.status = 'resolved';
      active.resolvedAt = new Date();
      await this.alertRepository.save(active);
    }
  }
}
