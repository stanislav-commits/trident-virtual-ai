import { formatError } from '../../common/utils/error.utils';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AlertEntity } from './entities/alert.entity';
import { ShipMetricCatalogEntity } from '../metrics/entities/ship-metric-catalog.entity';
import { AssetEntity } from '../assets/entities/asset.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { PmsService } from '../pms/pms.service';

export type AlertDto = AlertEntity & { assetName: string | null };

/** Grafana unified-alerting webhook payload (the bits we use). */
export interface GrafanaAlert {
  status?: 'firing' | 'resolved';
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  values?: Record<string, number>;
  valueString?: string;
  startsAt?: string;
  endsAt?: string;
  fingerprint?: string;
}
export interface GrafanaWebhookPayload {
  status?: string;
  alerts?: GrafanaAlert[];
  commonLabels?: Record<string, string>;
}

const SEVERITY_RANK: Record<string, number> = {
  info: 0,
  warning: 1,
  high: 2,
  critical: 3,
};

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    @InjectRepository(AlertEntity)
    private readonly alertRepository: Repository<AlertEntity>,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly catalogRepository: Repository<ShipMetricCatalogEntity>,
    @InjectRepository(AssetEntity)
    private readonly assetRepository: Repository<AssetEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    private readonly pmsService: PmsService,
    private readonly configService: ConfigService,
  ) {}

  /** Ingest one Grafana webhook batch; returns how many alerts were applied. */
  async ingest(payload: GrafanaWebhookPayload): Promise<{ applied: number }> {
    const alerts = payload?.alerts ?? [];
    let applied = 0;
    for (const a of alerts) {
      try {
        await this.applyOne(a, payload.commonLabels ?? {});
        applied++;
      } catch (e) {
        this.logger.warn(
          `Failed to apply alert ${a?.fingerprint}: ${
            formatError(e)
          }`,
        );
      }
    }
    return { applied };
  }

  private async applyOne(
    a: GrafanaAlert,
    common: Record<string, string>,
  ): Promise<void> {
    const labels = { ...common, ...(a.labels ?? {}) };
    const fingerprint = a.fingerprint || this.fallbackFingerprint(labels);
    const isResolved =
      (a.status ?? '').toLowerCase() === 'resolved';

    if (isResolved) {
      const active = await this.alertRepository.findOne({
        where: { fingerprint, status: 'firing' },
      });
      if (active) {
        active.status = 'resolved';
        active.resolvedAt = this.parseDate(a.endsAt) ?? new Date();
        await this.alertRepository.save(active);
      }
      return;
    }

    // Firing: resolve domain context from the metric. If no explicit metric_key
    // label, derive it from the Influx result labels Grafana carries on the
    // instance (bucket::_measurement::_field) so unlabelled rules still bind.
    const metricKey =
      labels.metric_key ||
      labels.metricKey ||
      this.deriveMetricKey(labels);
    const { shipId, assetId } = await this.resolve(metricKey, labels);
    const severity = this.normSeverity(labels.severity);
    const value = this.firstValue(a);
    const title =
      a.annotations?.summary?.trim() ||
      labels.alertname?.trim() ||
      metricKey ||
      'Metric alert';
    const startedAt = this.parseDate(a.startsAt) ?? new Date();

    const existing = await this.alertRepository.findOne({
      where: { fingerprint, status: 'firing' },
    });
    if (existing) {
      // Re-fire: refresh the live fields, keep the original episode.
      existing.value = value;
      existing.title = title.slice(0, 300);
      existing.message = a.annotations?.description ?? existing.message;
      existing.severity = severity;
      existing.lastSeenAt = new Date();
      if (shipId) existing.shipId = shipId;
      if (assetId) existing.assetId = assetId;
      await this.alertRepository.save(existing);
      return;
    }

    const saved = await this.alertRepository.save(
      this.alertRepository.create({
        shipId,
        assetId,
        metricKey,
        ruleName: (labels.alertname ?? title).slice(0, 255),
        severity,
        status: 'firing',
        value,
        title: title.slice(0, 300),
        message: a.annotations?.description ?? null,
        department: labels.department ?? null,
        labels: { ...labels, ...(a.annotations ?? {}) },
        fingerprint,
        startedAt,
        resolvedAt: null,
        lastSeenAt: new Date(),
      }),
    );

    if (shipId && this.shouldSpawnTask(severity)) {
      await this.spawnTask(saved);
    }
  }

  /** ship_metric_catalog: key (`bucket::measurement::field`) -> ship + asset. */
  private async resolve(
    metricKey: string | null,
    labels: Record<string, string>,
  ): Promise<{ shipId: string | null; assetId: string | null }> {
    if (metricKey) {
      // metric_key (bucket::measurement::field) is unique only PER SHIP, so on a
      // multi-vessel fleet a `ship_id` label disambiguates. Without it we fall
      // back to the first match (correct on a single vessel, or when buckets are
      // unique per ship).
      const where = labels.ship_id
        ? { key: metricKey, shipId: labels.ship_id }
        : { key: metricKey };
      const cat = await this.catalogRepository.findOne({
        where,
        select: ['shipId', 'boundAssetId'],
      });
      if (cat) {
        return { shipId: cat.shipId, assetId: cat.boundAssetId ?? null };
      }
    }
    // Explicit ship_id label wins next.
    if (labels.ship_id) {
      return { shipId: labels.ship_id, assetId: labels.asset_id ?? null };
    }
    // Single-vessel fallback: with exactly one real (non-platform) ship, every
    // alert belongs to it — so unlabelled rules still attach to the vessel.
    const ships = await this.shipRepository.find({
      where: { isPlatform: false },
      select: ['id'],
      take: 2,
    });
    if (ships.length === 1) {
      return { shipId: ships[0].id, assetId: labels.asset_id ?? null };
    }
    return { shipId: null, assetId: labels.asset_id ?? null };
  }

  /**
   * Build a `bucket::measurement::field` key from the Influx result labels
   * Grafana attaches to a firing instance. Bucket isn't a series label, so it
   * defaults to the fleet's trending bucket. Returns null if the shape is absent.
   */
  private deriveMetricKey(labels: Record<string, string>): string | null {
    const measurement = labels._measurement || labels.measurement;
    const field = labels._field || labels.field;
    if (!measurement || !field) {
      return null;
    }
    const bucket = labels.bucket || labels._bucket || 'Trending';
    return `${bucket}::${measurement}::${field}`;
  }

  private shouldSpawnTask(severity: string): boolean {
    const threshold = (
      this.configService.get<string>('integrations.grafanaAlerts.autoTaskSeverity') ??
      'critical'
    ).toLowerCase();
    if (threshold === 'off') return false;
    const need = SEVERITY_RANK[threshold] ?? SEVERITY_RANK.critical;
    return (SEVERITY_RANK[severity] ?? 0) >= need;
  }

  private async spawnTask(alert: AlertEntity): Promise<void> {
    if (!alert.shipId) return;
    try {
      const task = await this.pmsService.create(alert.shipId, {
        task: `ALERT: ${alert.title}`.slice(0, 200),
        category: 'Inspection',
        planning: 'unplanned',
        priority: alert.severity === 'critical' ? 'critical' : 'high',
        department: alert.department ?? null,
        description:
          `Auto-created from a ${alert.severity} metric alert.` +
          (alert.value != null ? ` Value: ${alert.value}.` : '') +
          (alert.metricKey ? `\nMetric: ${alert.metricKey}` : ''),
        assetIds: alert.assetId ? [alert.assetId] : [],
        source: 'alert',
      });
      alert.pmsTaskId = task?.id ?? null;
      await this.alertRepository.save(alert);
    } catch (e) {
      this.logger.warn(
        `Could not spawn PMS task for alert ${alert.id}: ${
          formatError(e)
        }`,
      );
    }
  }

  // ── read / actions ──

  async list(
    shipId: string,
    status?: string,
    allowedSources?: string[],
  ): Promise<AlertDto[]> {
    // allowedSources gates by alert kind (metric alarms vs cert reminders) per
    // the viewer's access matrix. undefined = no restriction (admin/unlinked).
    if (allowedSources && allowedSources.length === 0) return [];
    const where: Record<string, unknown> = { shipId };
    if (status) where.status = status;
    if (allowedSources && allowedSources.length < 2) {
      where.source = In(allowedSources);
    }
    const rows = await this.alertRepository.find({
      where,
      order: { startedAt: 'DESC' },
      take: 500,
    });
    return this.withAssetNames(rows);
  }

  /**
   * Reconcile certificate-expiry reminder alerts for a ship against the current
   * expiring/expired certificate set: fire (upsert) one per expiring cert and
   * resolve any whose cert is no longer expiring (renewed / removed). Cert
   * alerts share the bell with metric alarms but carry source='certificate'.
   */
  async reconcileCertificateAlerts(
    shipId: string,
    certs: Array<{
      docId: string;
      title: string;
      expiryDate: string | null;
      expired: boolean;
      assetId: string | null;
      message?: string | null;
    }>,
  ): Promise<void> {
    const currentIds = new Set(certs.map((c) => c.docId));
    const active = await this.alertRepository.find({
      where: { shipId, source: 'certificate', status: 'firing' },
    });
    for (const a of active) {
      if (!a.complianceDocId || !currentIds.has(a.complianceDocId)) {
        a.status = 'resolved';
        a.resolvedAt = new Date();
        await this.alertRepository.save(a);
      }
    }
    for (const c of certs) {
      const fingerprint = `cert:${c.docId}`;
      const severity = c.expired ? 'critical' : 'warning';
      const existing = await this.alertRepository.findOne({
        where: { fingerprint, status: 'firing' },
      });
      if (existing) {
        existing.severity = severity;
        existing.title = c.title.slice(0, 300);
        existing.message = c.message ?? existing.message;
        existing.assetId = c.assetId ?? existing.assetId;
        existing.lastSeenAt = new Date();
        await this.alertRepository.save(existing);
        continue;
      }
      await this.alertRepository.save(
        this.alertRepository.create({
          shipId,
          assetId: c.assetId,
          source: 'certificate',
          complianceDocId: c.docId,
          metricKey: null,
          ruleName: c.title.slice(0, 255),
          severity,
          status: 'firing',
          value: null,
          title: c.title.slice(0, 300),
          message: c.message ?? null,
          department: null,
          labels: { kind: 'certificate', expiryDate: c.expiryDate ?? '' },
          fingerprint,
          startedAt: new Date(),
          resolvedAt: null,
          lastSeenAt: new Date(),
        }),
      );
    }
  }

  async listForAsset(shipId: string, assetId: string): Promise<AlertDto[]> {
    const rows = await this.alertRepository.find({
      where: { shipId, assetId },
      order: { startedAt: 'DESC' },
      take: 200,
    });
    return this.withAssetNames(rows);
  }

  private async withAssetNames(rows: AlertEntity[]): Promise<AlertDto[]> {
    const ids = [
      ...new Set(rows.map((r) => r.assetId).filter((v): v is string => !!v)),
    ];
    const assets = ids.length
      ? await this.assetRepository.find({
          where: { id: In(ids) },
          select: ['id', 'displayName'],
        })
      : [];
    const nameById = new Map(assets.map((a) => [a.id, a.displayName]));
    return rows.map((r) => ({
      ...r,
      assetName: r.assetId ? (nameById.get(r.assetId) ?? null) : null,
    }));
  }

  async acknowledge(
    shipId: string,
    id: string,
    userId: string | null,
  ): Promise<AlertEntity> {
    const alert = await this.alertRepository.findOne({ where: { id, shipId } });
    if (!alert) throw new NotFoundException('Alert not found');
    alert.ackedAt = new Date();
    alert.ackedByUserId = userId;
    return this.alertRepository.save(alert);
  }

  // ── helpers ──

  private normSeverity(raw?: string): string {
    const v = (raw ?? '').toLowerCase().trim();
    if (v === 'critical' || v === 'crit') return 'critical';
    if (v === 'high' || v === 'error' || v === 'major') return 'high';
    if (v === 'info' || v === 'information') return 'info';
    if (v === 'warning' || v === 'warn' || v === 'minor') return 'warning';
    return 'warning';
  }

  private firstValue(a: GrafanaAlert): number | null {
    if (a.values && typeof a.values === 'object') {
      for (const v of Object.values(a.values)) {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
      }
    }
    return null;
  }

  private parseDate(s?: string): Date | null {
    if (!s) return null;
    const d = new Date(s);
    // Grafana sends "0001-01-01T00:00:00Z" for an absent endsAt.
    if (isNaN(d.getTime()) || d.getUTCFullYear() < 2000) return null;
    return d;
  }

  private fallbackFingerprint(labels: Record<string, string>): string {
    const basis = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join(',');
    let h = 0;
    for (let i = 0; i < basis.length; i++) {
      h = (Math.imul(31, h) + basis.charCodeAt(i)) | 0;
    }
    return `fb_${(h >>> 0).toString(16)}`;
  }
}
