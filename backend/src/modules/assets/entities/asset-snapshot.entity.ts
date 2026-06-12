import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('asset_snapshots')
@Index('IDX_asset_snapshots_ship_at', ['shipId', 'snapshotAt'])
export class AssetSnapshotEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  @CreateDateColumn({ name: 'snapshot_at', type: 'timestamptz' })
  snapshotAt!: Date;

  // Free-text reason — usually "pre-import: <filename>".
  @Column({ type: 'varchar', length: 80 })
  reason!: string;

  @Column({ name: 'asset_count', type: 'integer' })
  assetCount!: number;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  // Full asset rows as JSONB. Used for restore; never queried per-field.
  @Column({ type: 'jsonb' })
  payload!: unknown;
}
