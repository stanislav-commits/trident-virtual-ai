import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A metric alert received from Grafana's alerting engine (via webhook contact
 * point). Grafana evaluates the rule against InfluxDB and delivers firing /
 * resolved transitions here; Trident is the domain layer — it resolves the
 * alert to a ship + asset (via ship_metric_catalog), shows it in the UI/chat,
 * and optionally spawns a PMS task. One row per Grafana series (fingerprint);
 * re-fires update it in place, "resolved" closes it.
 */
@Entity('alerts')
@Index('IDX_alerts_ship_status', ['shipId', 'status'])
@Index('IDX_alerts_asset', ['assetId'])
@Index('IDX_alerts_fingerprint_active', ['fingerprint', 'status'])
export class AlertEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Resolved from the metric (ship_metric_catalog). Null if unresolvable. */
  @Column({ name: 'ship_id', type: 'uuid', nullable: true })
  shipId!: string | null;

  /** The asset the metric is bound to (ship_metric_catalog.bound_asset_id). */
  @Column({ name: 'asset_id', type: 'uuid', nullable: true })
  assetId!: string | null;

  /** Our metric identifier `bucket::measurement::field` from the rule label. */
  @Column({ name: 'metric_key', type: 'varchar', length: 512, nullable: true })
  metricKey!: string | null;

  /** Grafana alert rule name (labels.alertname). */
  @Column({ name: 'rule_name', type: 'varchar', length: 255 })
  ruleName!: string;

  /** critical | high | warning | info — from labels.severity. */
  @Column({ type: 'varchar', length: 16, default: 'warning' })
  severity!: string;

  /** firing | resolved */
  @Column({ type: 'varchar', length: 12, default: 'firing' })
  status!: string;

  @Column({ type: 'double precision', nullable: true })
  value!: number | null;

  @Column({ type: 'varchar', length: 300 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  message!: string | null;

  /** engine | bridge | ratings | null — drives department gating, like PMS. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  department!: string | null;

  /** Full Grafana label/annotation set, for debugging + future routing. */
  @Column({ type: 'jsonb', nullable: true })
  labels!: Record<string, unknown> | null;

  /** Grafana's stable series identifier — the dedup key across re-fires. */
  @Column({ type: 'varchar', length: 128 })
  fingerprint!: string;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  /** Last time Grafana re-sent this firing alert (heartbeat). */
  @Column({ name: 'last_seen_at', type: 'timestamptz' })
  lastSeenAt!: Date;

  /** PMS task auto-created for this alert (critical), if any. */
  @Column({ name: 'pms_task_id', type: 'uuid', nullable: true })
  pmsTaskId!: string | null;

  @Column({ name: 'acked_at', type: 'timestamptz', nullable: true })
  ackedAt!: Date | null;

  @Column({ name: 'acked_by_user_id', type: 'uuid', nullable: true })
  ackedByUserId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
