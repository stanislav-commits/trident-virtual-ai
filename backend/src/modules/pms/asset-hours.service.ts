import { formatError } from '../../common/utils/error.utils';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { InfluxService } from '../../integrations/influx/influx.service';
import { ShipMetricCatalogEntity } from '../metrics/entities/ship-metric-catalog.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { AssetHoursConfigEntity } from './entities/asset-hours-config.entity';
import { AssetHourReadingEntity } from './entities/asset-hour-reading.entity';
import { PmsTaskEntity } from './entities/pms-task.entity';
import { nextTaskCode } from './pms-task-code.util';
import { AssetEntity } from '../assets/entities/asset.entity';

export interface SetHoursConfigInput {
  source: string; // none | manual | metric_direct | metric_derived
  metricCatalogId?: string | null;
  baselineHours?: number | null;
  baselineAt?: string | null;
  runningThreshold?: number | null;
}

export interface BulkHoursConfigItem extends SetHoursConfigInput {
  assetId: string;
}

export interface HoursMetricOption {
  id: string;
  key: string;
  label: string; // measurement.field
  unit: string | null;
  kind: string | null;
  boundAssetId: string | null;
}

export interface HoursOverviewAsset {
  assetId: string;
  name: string;
  internalId: string | null;
  hoursTaskCount: number;
  sampleTasks: string[];
  source: string;
  metricCatalogId: string | null;
  /** Candidate hour-counter metrics, best first (ids into metricPool). */
  suggestions: { metricId: string; score: number }[];
}

@Injectable()
export class AssetHoursService {
  private readonly logger = new Logger(AssetHoursService.name);

  constructor(
    @InjectRepository(AssetHoursConfigEntity)
    private readonly configRepository: Repository<AssetHoursConfigEntity>,
    @InjectRepository(AssetHourReadingEntity)
    private readonly readingRepository: Repository<AssetHourReadingEntity>,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly catalogRepository: Repository<ShipMetricCatalogEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    @InjectRepository(PmsTaskEntity)
    private readonly taskRepository: Repository<PmsTaskEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    private readonly influxService: InfluxService,
  ) {}

  async getConfig(shipId: string, assetId: string) {
    const cfg = await this.configRepository.findOne({
      where: { assetId, shipId },
    });
    const readings = await this.readingRepository.find({
      where: { assetId },
      order: { readOn: 'DESC' },
      take: 12,
    });
    return {
      source: cfg?.source ?? 'none',
      metricCatalogId: cfg?.metricCatalogId ?? null,
      baselineHours: cfg?.baselineHours != null ? Number(cfg.baselineHours) : null,
      baselineAt: cfg?.baselineAt ? cfg.baselineAt.toISOString() : null,
      runningThreshold: cfg ? Number(cfg.runningThreshold) : 0,
      currentHours: await this.currentHours(shipId, assetId),
      readings: readings.map((r) => ({
        id: r.id,
        hours: Number(r.hours),
        readOn: r.readOn,
        note: r.note,
      })),
    };
  }

  async setConfig(shipId: string, assetId: string, input: SetHoursConfigInput) {
    let cfg = await this.configRepository.findOne({
      where: { assetId, shipId },
    });
    if (!cfg) {
      cfg = this.configRepository.create({ assetId, shipId });
    }
    cfg.source = input.source;
    cfg.metricCatalogId = input.metricCatalogId ?? null;
    cfg.baselineHours =
      input.baselineHours != null ? String(input.baselineHours) : null;
    cfg.baselineAt = input.baselineAt ? new Date(input.baselineAt) : null;
    cfg.runningThreshold = String(input.runningThreshold ?? 0);
    await this.configRepository.save(cfg);

    // Manual counters can't be read remotely — keep a monthly reminder
    // task (due on the 1st) so the crew is prompted to log the reading.
    if (input.source === 'manual') {
      await this.ensureHoursReminder(shipId, assetId);
    } else {
      await this.removeHoursReminder(shipId, assetId);
    }
    return this.getConfig(shipId, assetId);
  }

  async addReading(
    shipId: string,
    assetId: string,
    input: { hours: number; readOn?: string; note?: string | null },
  ) {
    await this.readingRepository.save(
      this.readingRepository.create({
        shipId,
        assetId,
        hours: String(input.hours),
        readOn: input.readOn ?? new Date().toISOString().slice(0, 10),
        note: input.note ?? null,
      }),
    );
    await this.completeHoursReminder(shipId, assetId);
    return this.getConfig(shipId, assetId);
  }

  // ── bulk binding (phase C) ──

  /**
   * Everything the bulk hours-binding UX needs in one call: the assets that
   * have an hours-legged task (plus any already-configured assets), their
   * current config, and scored hour-counter metric candidates per asset.
   * Deliberately does NOT resolve currentHours (one Influx query per asset) —
   * the bulk apply returns live readings as its verification step instead.
   */
  async hoursOverview(shipId: string) {
    // Assets with an ACTIVE hours-legged task.
    const taskRows: {
      asset_id: string;
      task: string;
    }[] = await this.taskRepository
      .createQueryBuilder('t')
      .innerJoin('pms_task_assets', 'l', 'l.task_id = t.id')
      .select('l.asset_id', 'asset_id')
      .addSelect('t.task', 'task')
      .where('t.ship_id = :shipId', { shipId })
      .andWhere('t.interval_hours IS NOT NULL')
      .andWhere('t.completed_at IS NULL')
      .getRawMany();

    const tasksByAsset = new Map<string, string[]>();
    for (const row of taskRows) {
      const list = tasksByAsset.get(row.asset_id) ?? [];
      list.push(row.task);
      tasksByAsset.set(row.asset_id, list);
    }

    const configs = await this.configRepository.find({ where: { shipId } });
    const configByAsset = new Map(configs.map((c) => [c.assetId, c]));

    // Row set = assets with hours tasks ∪ assets already configured.
    const assetIds = new Set<string>(tasksByAsset.keys());
    for (const c of configs) {
      if (c.source !== 'none') assetIds.add(c.assetId);
    }
    if (assetIds.size === 0) {
      return { assets: [], metricPool: [] };
    }

    const assets = await this.assetRepository.find({
      where: { id: In([...assetIds]) },
    });

    // Candidate pool: enabled metrics that look like hour counters, plus any
    // metric already bound to one of these assets (strongest signal of all).
    const catalog = await this.catalogRepository.find({
      where: { shipId, isEnabled: true },
    });
    const pool = catalog.filter(
      (m) =>
        this.isHoursMetric(m) ||
        (m.boundAssetId != null && assetIds.has(m.boundAssetId)),
    );

    const metricPool: HoursMetricOption[] = pool.map((m) => ({
      id: m.id,
      key: m.key,
      label: `${m.key.split('::')[1] ?? m.bucket}.${m.field}`,
      unit: m.aiUnit,
      kind: m.aiKind,
      boundAssetId: m.boundAssetId,
    }));

    const overviewAssets: HoursOverviewAsset[] = assets
      .map((asset) => {
        const cfg = configByAsset.get(asset.id);
        const titles = tasksByAsset.get(asset.id) ?? [];
        return {
          assetId: asset.id,
          name: asset.displayName,
          internalId: asset.assetIdInternal ?? null,
          hoursTaskCount: titles.length,
          sampleTasks: titles.slice(0, 3),
          source: cfg?.source ?? 'none',
          metricCatalogId: cfg?.metricCatalogId ?? null,
          suggestions: this.scoreMetricCandidates(asset, pool),
        };
      })
      // Unbound assets that need a source first, then by task count.
      .sort((a, b) => {
        const aNeeds = a.source === 'none' ? 0 : 1;
        const bNeeds = b.source === 'none' ? 0 : 1;
        if (aNeeds !== bNeeds) return aNeeds - bNeeds;
        return b.hoursTaskCount - a.hoursTaskCount;
      });

    return { assets: overviewAssets, metricPool };
  }

  /**
   * Apply many hours configs in one call. Sequential on purpose: setConfig may
   * create the manual-reminder task (task-code sequence) and each result
   * resolves live currentHours — the caller's verification signal.
   */
  async bulkSetConfig(shipId: string, items: BulkHoursConfigItem[]) {
    const results: {
      assetId: string;
      ok: boolean;
      source?: string;
      currentHours?: number | null;
      error?: string;
    }[] = [];
    const VALID_SOURCES = ['none', 'manual', 'metric_direct', 'metric_derived'];
    for (const item of items) {
      try {
        if (!VALID_SOURCES.includes(item.source)) {
          throw new Error(`Unknown source "${item.source}"`);
        }
        if (item.source.startsWith('metric')) {
          if (!item.metricCatalogId) {
            throw new Error('Metric source needs a metric');
          }
          const metric = await this.catalogRepository.findOne({
            where: { id: item.metricCatalogId, shipId },
          });
          if (!metric) {
            throw new Error('Metric not found on this ship');
          }
        }
        // Bulk edits only carry source+metric — keep the fields they don't
        // touch (derived baseline/threshold) instead of silently wiping them.
        const existing = await this.configRepository.findOne({
          where: { assetId: item.assetId, shipId },
        });
        const cfg = await this.setConfig(shipId, item.assetId, {
          source: item.source,
          metricCatalogId: item.metricCatalogId ?? null,
          baselineHours:
            item.baselineHours !== undefined
              ? item.baselineHours
              : existing?.baselineHours != null
                ? Number(existing.baselineHours)
                : null,
          baselineAt:
            item.baselineAt !== undefined
              ? item.baselineAt
              : (existing?.baselineAt?.toISOString() ?? null),
          runningThreshold:
            item.runningThreshold !== undefined
              ? item.runningThreshold
              : existing != null
                ? Number(existing.runningThreshold)
                : null,
        });
        results.push({
          assetId: item.assetId,
          ok: true,
          source: cfg.source,
          currentHours: cfg.currentHours,
        });
      } catch (error) {
        results.push({
          assetId: item.assetId,
          ok: false,
          error: formatError(error),
        });
      }
    }
    return { results };
  }

  /** Does this catalog row look like a running-hours counter? */
  private isHoursMetric(m: ShipMetricCatalogEntity): boolean {
    const unit = (m.aiUnit ?? '').trim().toLowerCase();
    if (['h', 'hr', 'hrs', 'hour', 'hours'].includes(unit)) return true;
    const HOURS_RE =
      /(^|[^a-z])(hours?|hrs?|run_?time|running_?hours?|operating_?hours?|engine_?hours?|moto_?hours?)([^a-z]|$)/i;
    return (
      HOURS_RE.test(m.field) ||
      HOURS_RE.test(m.key) ||
      HOURS_RE.test(m.description ?? '') ||
      HOURS_RE.test(m.aiDescription ?? '')
    );
  }

  /**
   * Token-overlap score of each candidate metric against one asset (same idea
   * as the metric-understanding asset prefilter, reversed): measurement token
   * match ×2, field/description ×1, PS/SB side agreement +3 / conflict −4,
   * already-bound-to-this-asset +10. Top 5, positive scores only.
   */
  private scoreMetricCandidates(
    asset: AssetEntity,
    pool: ShipMetricCatalogEntity[],
  ): { metricId: string; score: number }[] {
    const assetTokens = new Set(
      this.tokenize(
        [
          asset.assetIdInternal,
          asset.displayName,
          asset.brand,
          asset.model,
          asset.sfiSubName,
        ]
          .filter(Boolean)
          .join(' '),
      ),
    );
    const assetSide = this.sideOf(assetTokens);

    return pool
      .map((m) => {
        const measurement = m.key.split('::')[1] ?? m.bucket;
        const measurementTokens = this.tokenize(measurement);
        const otherTokens = this.tokenize(
          `${m.field} ${m.description ?? ''} ${m.aiDescription ?? ''}`,
        );
        let score = 0;
        for (const t of measurementTokens) {
          if (assetTokens.has(t)) score += 2;
        }
        for (const t of new Set(otherTokens)) {
          if (assetTokens.has(t)) score += 1;
        }
        const metricSide = this.sideOf(
          new Set([...measurementTokens, ...otherTokens]),
        );
        if (assetSide && metricSide) {
          score += assetSide === metricSide ? 3 : -4;
        }
        if (m.boundAssetId === asset.id) score += 10;
        return { metricId: m.id, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  private tokenize(text: string): string[] {
    return (
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        // Keep single-digit tokens — "Jet Ski 2" vs "Jet Ski 1" and numbered
        // unit pairs differ only by that digit.
        .filter((t) => t.length >= 2 || /\d/.test(t))
        // "02" and "2" must compare equal (register ids zero-pad).
        .map((t) => (/^\d+$/.test(t) ? String(Number(t)) : t))
    );
  }

  private sideOf(tokens: Set<string>): 'port' | 'stbd' | null {
    if (tokens.has('port') || tokens.has('ps')) return 'port';
    if (
      tokens.has('stbd') ||
      tokens.has('starboard') ||
      tokens.has('sb') ||
      tokens.has('stb')
    ) {
      return 'stbd';
    }
    return null;
  }

  // ── monthly hours-reading reminder (auto task) ──

  private firstOfNextMonth(from = new Date()): string {
    // Build in UTC so toISOString() can't roll back a day across timezones.
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    return d.toISOString().slice(0, 10);
  }

  private async findReminder(
    shipId: string,
    assetId: string,
  ): Promise<PmsTaskEntity | null> {
    return this.taskRepository
      .createQueryBuilder('t')
      .innerJoin('pms_task_assets', 'l', 'l.task_id = t.id')
      .leftJoinAndSelect('t.assets', 'a')
      .where('t.ship_id = :shipId', { shipId })
      .andWhere('l.asset_id = :assetId', { assetId })
      .andWhere("t.source = 'hours_reminder'")
      .getOne();
  }

  private async ensureHoursReminder(
    shipId: string,
    assetId: string,
  ): Promise<void> {
    if (await this.findReminder(shipId, assetId)) return;
    const asset = await this.assetRepository.findOne({
      where: { id: assetId },
    });
    await this.taskRepository.save(
      this.taskRepository.create({
        shipId,
        task: `Record running hours — ${asset?.displayName ?? 'asset'}`,
        category: 'Inspection',
        planning: 'planned',
        description:
          'Local hour counter — read the gauge and log it in the asset PMS tab.',
        priority: 'low',
        dueDate: this.firstOfNextMonth(),
        repeatDate: true,
        intervalValue: 1,
        intervalUnit: 'months',
        source: 'hours_reminder',
        taskCode: await nextTaskCode(
          this.taskRepository.manager,
          shipId,
          'maintenance',
        ),
        assets: asset ? [asset] : [],
      }),
    );
  }

  private async removeHoursReminder(
    shipId: string,
    assetId: string,
  ): Promise<void> {
    const reminder = await this.findReminder(shipId, assetId);
    if (reminder) await this.taskRepository.delete(reminder.id);
  }

  private async completeHoursReminder(
    shipId: string,
    assetId: string,
  ): Promise<void> {
    const reminder = await this.findReminder(shipId, assetId);
    if (!reminder) return;
    reminder.lastDoneAt = new Date().toISOString().slice(0, 10);
    reminder.dueDate = this.firstOfNextMonth(); // next reading due next 1st
    await this.taskRepository.save(reminder);
  }

  /**
   * Resolve current running hours for an asset, or null if no source is
   * configured / data is unavailable.
   */
  async currentHours(shipId: string, assetId: string): Promise<number | null> {
    const cfg = await this.configRepository.findOne({
      where: { assetId, shipId },
    });
    if (!cfg || cfg.source === 'none') return null;

    if (cfg.source === 'manual') {
      const latest = await this.readingRepository.findOne({
        where: { assetId },
        order: { readOn: 'DESC' },
      });
      return latest ? Number(latest.hours) : null;
    }

    // metric-based sources need the Influx selector + org.
    const metric = cfg.metricCatalogId
      ? await this.catalogRepository.findOne({
          where: { id: cfg.metricCatalogId },
        })
      : null;
    const ship = await this.shipRepository.findOne({ where: { id: shipId } });
    if (!metric || !ship?.organizationName) return null;
    const selector = {
      bucket: metric.bucket,
      // key = bucket::measurement::field; measurement is the middle segment.
      measurement: metric.key.split('::')[1] ?? metric.bucket,
      field: metric.field,
    };

    try {
      if (cfg.source === 'metric_direct') {
        const sample = await this.influxService.queryMetricRange(
          ship.organizationName,
          selector,
          this.lookbackStart(),
          new Date(),
          'last',
        );
        const v = sample?.value;
        return typeof v === 'number' ? v : v != null ? Number(v) : null;
      }

      if (cfg.source === 'metric_derived') {
        const baseline =
          cfg.baselineHours != null ? Number(cfg.baselineHours) : 0;
        const since = cfg.baselineAt ?? this.lookbackStart();
        const runtime = await this.runtimeHoursSince(
          ship.organizationName,
          selector,
          since,
          Number(cfg.runningThreshold),
        );
        return runtime == null ? null : baseline + runtime;
      }
    } catch (error) {
      this.logger.warn(
        `currentHours influx query failed for asset ${assetId}: ${
          formatError(error)
        }`,
      );
    }
    return null;
  }

  /**
   * Runtime hours since `since`: counts 1-hour windows whose mean value
   * exceeds `threshold` (e.g. active power > 0 ⇒ the machine was running
   * that hour). Approximate but robust to irregular sampling.
   */
  private async runtimeHoursSince(
    orgName: string,
    selector: { bucket: string; measurement: string; field: string },
    since: Date,
    threshold: number,
  ): Promise<number | null> {
    const flux = `
from(bucket: "${selector.bucket}")
  |> range(start: ${since.toISOString()})
  |> filter(fn: (r) => r._measurement == "${selector.measurement.replace(/"/g, '\\"')}" and r._field == "${selector.field.replace(/"/g, '\\"')}")
  |> aggregateWindow(every: 1h, fn: mean, createEmpty: false)
  |> filter(fn: (r) => r._value > ${threshold})
  |> count()
  |> keep(columns: ["_value"])
`.trim();
    const { rows } = await this.influxService.queryRawFlux(orgName, flux, 5);
    if (!rows.length) return 0;
    const v = (rows[0] as Record<string, unknown>)._value;
    return typeof v === 'number' ? v : v != null ? Number(v) : 0;
  }

  private lookbackStart(): Date {
    // Direct counters: a generous window to catch the latest sample.
    return new Date(Date.now() - 90 * 24 * 3600 * 1000);
  }
}
