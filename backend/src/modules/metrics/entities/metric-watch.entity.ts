import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A crew-created metric watch ("следи за баком 5P, скажи когда меньше 15%"):
 * created from the chat via the create_metric_watch tool, checked every few
 * minutes by MetricWatchCheckerService, and surfaced as a Notifications-panel
 * entry when the condition trips. Threshold is stored in the metric's
 * DISPLAY units (already scaled) — the checker applies the catalog
 * scaleFactor to raw values before comparing.
 */
@Entity('metric_watches')
@Index('IDX_metric_watches_ship_active', ['shipId', 'isActive'])
export class MetricWatchEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  /** Who asked for the watch (chat session owner). */
  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  /** The catalog metric being watched. */
  @Column({ name: 'metric_catalog_id', type: 'uuid' })
  metricCatalogId!: string;

  /** Human label, e.g. "Fuel Tank 5P below 15% (504 L)". */
  @Column({ type: 'varchar', length: 200 })
  label!: string;

  /** below | above */
  @Column({ type: 'varchar', length: 8 })
  condition!: string;

  /** Trigger threshold, in the metric's display units. */
  @Column({ type: 'double precision' })
  threshold!: number;

  /** Display unit for messages, e.g. "L", "%", "°C". */
  @Column({ type: 'varchar', length: 32, nullable: true })
  unit!: string | null;

  /** ok | triggered — drives edge-triggered notifications. */
  @Column({ type: 'varchar', length: 12, default: 'ok' })
  state!: string;

  @Column({ name: 'last_value', type: 'double precision', nullable: true })
  lastValue!: number | null;

  @Column({ name: 'last_checked_at', type: 'timestamptz', nullable: true })
  lastCheckedAt!: Date | null;

  @Column({ name: 'triggered_at', type: 'timestamptz', nullable: true })
  triggeredAt!: Date | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
