import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AssetEntity } from '../../assets/entities/asset.entity';
import { ShipEntity } from '../../ships/entities/ship.entity';

export type MetricAiKind = 'gauge' | 'counter' | 'rate' | 'state';

@Entity('ship_metric_catalog')
@Index('IDX_ship_metric_catalog_ship_bucket', ['shipId', 'bucket'])
@Index('IDX_ship_metric_catalog_ship_key', ['shipId', 'key'], { unique: true })
@Index('IDX_ship_metric_catalog_bound_asset', ['boundAssetId'])
export class ShipMetricCatalogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  @ManyToOne(() => ShipEntity, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'ship_id' })
  ship!: ShipEntity;

  @Column({ type: 'varchar', length: 512 })
  key!: string;

  @Column({ type: 'varchar', length: 255 })
  bucket!: string;

  @Column({ type: 'varchar', length: 255 })
  field!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'is_enabled', type: 'boolean', default: true })
  isEnabled!: boolean;

  @Column({ name: 'synced_at', type: 'timestamptz' })
  syncedAt!: Date;

  // ── AI-generated metadata (Phase 1 of the metric-understanding rebuild) ──
  // Populated by MetricUnderstandingService at sync time and on demand.

  @Column({ name: 'ai_description', type: 'text', nullable: true })
  aiDescription!: string | null;

  @Column({ name: 'ai_kind', type: 'varchar', length: 20, nullable: true })
  aiKind!: MetricAiKind | null;

  @Column({ name: 'ai_unit', type: 'varchar', length: 30, nullable: true })
  aiUnit!: string | null;

  @Column({ name: 'ai_unit_confidence', type: 'real', nullable: true })
  aiUnitConfidence!: number | null;

  // Effective asset binding. NULL = unbound. May be set by AI (with
  // aiBoundConfidence != null) or by admin (in which case aiBoundConfidence
  // is NULL — "manual override").
  @Column({ name: 'bound_asset_id', type: 'uuid', nullable: true })
  boundAssetId!: string | null;

  @ManyToOne(() => AssetEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'bound_asset_id' })
  boundAsset!: AssetEntity | null;

  @Column({ name: 'ai_bound_confidence', type: 'real', nullable: true })
  aiBoundConfidence!: number | null;

  // Stat fingerprint that the AI saw at analysis time. Useful for the UI
  // ("typical: 0–82 L/h, median 0") without re-querying Influx, and as a
  // baseline for drift detection on next sync.
  @Column({ name: 'ai_typical_p5', type: 'double precision', nullable: true })
  aiTypicalP5!: number | null;

  @Column({ name: 'ai_typical_p50', type: 'double precision', nullable: true })
  aiTypicalP50!: number | null;

  @Column({ name: 'ai_typical_p95', type: 'double precision', nullable: true })
  aiTypicalP95!: number | null;

  @Column({ name: 'ai_non_zero_share_pct', type: 'real', nullable: true })
  aiNonZeroSharePct!: number | null;

  @Column({ name: 'ai_is_monotonic', type: 'boolean', nullable: true })
  aiIsMonotonic!: boolean | null;

  // JSON-stringified arrays; small enough that a separate table is overkill.
  @Column({ name: 'ai_questions_can_answer', type: 'text', nullable: true })
  aiQuestionsCanAnswer!: string | null;

  @Column({ name: 'ai_warnings', type: 'text', nullable: true })
  aiWarnings!: string | null;

  @Column({ name: 'ai_reasoning', type: 'text', nullable: true })
  aiReasoning!: string | null;

  @Column({ name: 'ai_generated_at', type: 'timestamptz', nullable: true })
  aiGeneratedAt!: Date | null;

  @Column({ name: 'ai_model', type: 'varchar', length: 50, nullable: true })
  aiModel!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
