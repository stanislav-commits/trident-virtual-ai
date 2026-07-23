import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { InfluxService } from '../../integrations/influx/influx.service';
import { AlertEntity } from '../alerts/entities/alert.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';

/**
 * Daily deterministic trend scan: compares each equipment-bound gauge's
 * recent average against its AI-profiled typical range (p5–p95, stored raw
 * in the catalog) and posts a Notifications-panel entry for metrics
 * drifting outside it. Pure Influx reads + stored percentiles — no LLM.
 *
 * Off by default (TREND_WARNINGS_ENABLED=true to arm): a scan is a few
 * hundred quick Influx queries per ship, and the operator should opt into
 * the notification volume deliberately. Capped at 10 warnings/ship/day
 * (highest deviation first); re-detections on later days get fresh
 * fingerprints, same-day re-runs upsert.
 */
@Injectable()
export class TrendWarningService {
  private readonly logger = new Logger(TrendWarningService.name);
  private running = false;

  /** Fraction of the typical range a value must exceed the band by. */
  private static readonly BAND_MARGIN = 0.1;
  /** Deviation (fraction of range) that upgrades info → warning. */
  private static readonly WARN_DEVIATION = 0.25;
  private static readonly MAX_PER_SHIP = 10;

  constructor(
    private readonly configService: ConfigService,
    private readonly influxService: InfluxService,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly catalogRepository: Repository<ShipMetricCatalogEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    @InjectRepository(AlertEntity)
    private readonly alertRepository: Repository<AlertEntity>,
  ) {}

  @Cron('0 0 5 * * *')
  async runScheduled(): Promise<void> {
    if (!this.configService.get<boolean>('alerts.trendWarningsEnabled', false)) {
      return;
    }
    await this.scanAllShips();
  }

  async scanAllShips(): Promise<{ ships: number; warnings: number }> {
    if (this.running) return { ships: 0, warnings: 0 };
    this.running = true;
    try {
      const ships = await this.shipRepository.find({
        where: { isPlatform: false },
      });
      const connected = ships.filter((s) => s.organizationName);
      let warnings = 0;
      for (const ship of connected) {
        try {
          warnings += await this.scanShip(ship);
        } catch (error) {
          this.logger.error(
            `Trend scan failed for ship ${ship.id}: ${String(error)}`,
          );
        }
      }
      this.logger.log(
        `Trend scan: ${connected.length} ship(s), ${warnings} warning(s) posted`,
      );
      return { ships: connected.length, warnings };
    } finally {
      this.running = false;
    }
  }

  private async scanShip(ship: ShipEntity): Promise<number> {
    // Equipment-bound, actively-reporting, non-monotonic gauges with a
    // usable typical band.
    const metrics = await this.catalogRepository.find({
      where: {
        shipId: ship.id,
        isEnabled: true,
        boundAssetId: Not(IsNull()),
        aiTypicalP5: Not(IsNull()),
        aiTypicalP95: Not(IsNull()),
      },
      relations: { boundAsset: true },
    });
    const candidates = metrics.filter(
      (m) =>
        m.aiIsMonotonic !== true &&
        (m.aiNonZeroSharePct == null || m.aiNonZeroSharePct >= 30) &&
        m.aiTypicalP95! > m.aiTypicalP5!,
    );

    const found: Array<{
      metric: ShipMetricCatalogEntity;
      value: number;
      deviation: number;
      dir: 'above' | 'below';
    }> = [];
    for (const metric of candidates) {
      try {
        const sample = await this.influxService.queryMetricRange(
          ship.organizationName!,
          {
            bucket: metric.bucket,
            measurement: metric.key.split('::')[1] ?? metric.bucket,
            field: metric.field,
          },
          new Date(Date.now() - 6 * 3600 * 1000),
          new Date(),
          'mean',
        );
        const raw = sample?.value;
        if (raw == null || !Number.isFinite(Number(raw))) continue;
        const value = Number(raw);
        const p5 = metric.aiTypicalP5!;
        const p95 = metric.aiTypicalP95!;
        // A flat zero on a normally-positive gauge means the equipment is
        // OFF — normal, not an anomaly (engine-state-first rule).
        if (value === 0 && p5 > 0) continue;
        const range = p95 - p5;
        const margin = range * TrendWarningService.BAND_MARGIN;
        if (value > p95 + margin) {
          found.push({
            metric,
            value,
            deviation: (value - p95) / range,
            dir: 'above',
          });
        } else if (value < p5 - margin) {
          found.push({
            metric,
            value,
            deviation: (p5 - value) / range,
            dir: 'below',
          });
        }
      } catch {
        // one bad metric must not kill the sweep
      }
    }

    found.sort((a, b) => b.deviation - a.deviation);
    const top = found.slice(0, TrendWarningService.MAX_PER_SHIP);
    const today = new Date().toISOString().slice(0, 10);
    let posted = 0;
    for (const f of top) {
      await this.upsertTrendNotification(ship.id, f, today);
      posted += 1;
    }
    return posted;
  }

  private fmt(v: number): string {
    if (Math.abs(v) >= 100) return v.toFixed(0);
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  private async upsertTrendNotification(
    shipId: string,
    f: {
      metric: ShipMetricCatalogEntity;
      value: number;
      deviation: number;
      dir: 'above' | 'below';
    },
    today: string,
  ): Promise<void> {
    const m = f.metric;
    const sf =
      typeof m.scaleFactor === 'number' &&
      Number.isFinite(Number(m.scaleFactor)) &&
      Number(m.scaleFactor) !== 0
        ? Number(m.scaleFactor)
        : 1;
    const unit = m.aiUnit ? ` ${m.aiUnit}` : '';
    // Human name only — never the internal metric key (hygiene rule).
    const label =
      (m.boundAsset?.displayName ? `${m.boundAsset.displayName} — ` : '') +
      m.field.replace(/_/g, ' ');
    const message =
      `${label}: 6h average ${this.fmt(f.value * sf)}${unit} is ${f.dir} the typical range ` +
      `${this.fmt(m.aiTypicalP5! * sf)}–${this.fmt(m.aiTypicalP95! * sf)}${unit}. ` +
      'Worth a check if this is not expected for the current operating mode.';
    const fingerprint = `trend-${m.id}-${today}`;
    const severity =
      f.deviation >= TrendWarningService.WARN_DEVIATION ? 'warning' : 'info';
    const now = new Date();

    const existing = await this.alertRepository.findOne({
      where: { fingerprint, status: 'firing' },
    });
    if (existing) {
      existing.message = message;
      existing.value = f.value * sf;
      existing.severity = severity;
      existing.lastSeenAt = now;
      await this.alertRepository.save(existing);
      return;
    }
    // A fresh day's detection supersedes any still-firing older trend entry
    // for the same metric so the panel doesn't pile up duplicates.
    const stale = await this.alertRepository
      .createQueryBuilder('a')
      .where('a.source = :src', { src: 'trend' })
      .andWhere('a.status = :st', { st: 'firing' })
      .andWhere('a.fingerprint LIKE :fp', { fp: `trend-${m.id}-%` })
      .getMany();
    for (const s of stale) {
      s.status = 'resolved';
      s.resolvedAt = now;
      await this.alertRepository.save(s);
    }
    await this.alertRepository.save(
      this.alertRepository.create({
        shipId,
        assetId: m.boundAssetId,
        source: 'trend',
        ruleName: 'trend-warning',
        severity,
        status: 'firing',
        value: f.value * sf,
        title: `Trend: ${label}`.slice(0, 300),
        message,
        fingerprint,
        startedAt: now,
        lastSeenAt: now,
      }),
    );
  }
}
