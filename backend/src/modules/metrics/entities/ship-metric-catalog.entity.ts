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
import { ShipEntity } from '../../ships/entities/ship.entity';

@Entity('ship_metric_catalog')
@Index('IDX_ship_metric_catalog_ship_bucket', ['shipId', 'bucket'])
@Index('IDX_ship_metric_catalog_ship_key', ['shipId', 'key'], { unique: true })
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

  @Column({ name: 'synced_at', type: 'timestamptz' })
  syncedAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
