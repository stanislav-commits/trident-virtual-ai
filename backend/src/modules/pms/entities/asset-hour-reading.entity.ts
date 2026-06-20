import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** A manual running-hours reading (local counter the user reads). */
@Entity('asset_hour_readings')
@Index('IDX_asset_hour_readings_asset', ['assetId', 'readOn'])
export class AssetHourReadingEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  @Column({ type: 'numeric', precision: 12, scale: 1 })
  hours!: string;

  @Column({ name: 'read_on', type: 'date' })
  readOn!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
