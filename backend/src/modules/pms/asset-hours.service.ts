import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { InfluxService } from '../../integrations/influx/influx.service';
import { ShipMetricCatalogEntity } from '../metrics/entities/ship-metric-catalog.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { AssetHoursConfigEntity } from './entities/asset-hours-config.entity';
import { AssetHourReadingEntity } from './entities/asset-hour-reading.entity';
import { PmsTaskEntity } from './entities/pms-task.entity';
import { AssetEntity } from '../assets/entities/asset.entity';

export interface SetHoursConfigInput {
  source: string; // none | manual | metric_direct | metric_derived
  metricCatalogId?: string | null;
  baselineHours?: number | null;
  baselineAt?: string | null;
  runningThreshold?: number | null;
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
          error instanceof Error ? error.message : String(error)
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
