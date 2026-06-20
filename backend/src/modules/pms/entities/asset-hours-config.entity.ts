import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Per-asset running-hours source configuration (1:1 with an asset). */
@Entity('asset_hours_config')
@Index('IDX_asset_hours_config_ship', ['shipId'])
export class AssetHoursConfigEntity {
  @PrimaryColumn({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  /** none | manual | metric_direct | metric_derived */
  @Column({ type: 'varchar', length: 16, default: 'none' })
  source!: string;

  @Column({ name: 'metric_catalog_id', type: 'uuid', nullable: true })
  metricCatalogId!: string | null;

  @Column({ name: 'baseline_hours', type: 'numeric', precision: 12, scale: 1, nullable: true })
  baselineHours!: string | null;

  @Column({ name: 'baseline_at', type: 'timestamptz', nullable: true })
  baselineAt!: Date | null;

  @Column({ name: 'running_threshold', type: 'numeric', precision: 12, scale: 2, default: 0 })
  runningThreshold!: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
