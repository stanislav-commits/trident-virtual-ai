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

/**
 * A defect / failure record (chat-first v1): the crew reports breakdowns in
 * conversation ("порвался ремень на компрессоре"), the assistant logs them
 * here, and later answers "what keeps failing", "what was the cause last
 * time" from this register. Closing a defect records cause / action /
 * parts — the fields recurrence analytics feed on.
 */
@Entity('defects')
@Index('IDX_defects_ship_status', ['shipId', 'status'])
@Index('IDX_defects_asset', ['assetId'])
export class DefectEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  /** The failed equipment, when identified in the register. */
  @Column({ name: 'asset_id', type: 'uuid', nullable: true })
  assetId!: string | null;

  @ManyToOne(() => AssetEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'asset_id' })
  asset!: AssetEntity | null;

  /** Short failure title, e.g. "Compressor drive belt snapped". */
  @Column({ type: 'varchar', length: 300 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  /** Root cause — usually filled at closure. */
  @Column({ type: 'text', nullable: true })
  cause!: string | null;

  /** What was done to fix it. */
  @Column({ name: 'action_taken', type: 'text', nullable: true })
  actionTaken!: string | null;

  /** Parts/consumables used, free text. */
  @Column({ name: 'parts_used', type: 'text', nullable: true })
  partsUsed!: string | null;

  /** open | closed */
  @Column({ type: 'varchar', length: 12, default: 'open' })
  status!: string;

  /** When the failure occurred/was noticed. */
  @Column({ name: 'reported_on', type: 'date' })
  reportedOn!: string;

  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ name: 'reported_by_user_id', type: 'uuid', nullable: true })
  reportedByUserId!: string | null;

  /** chat | manual — how the record entered the system. */
  @Column({ type: 'varchar', length: 16, default: 'chat' })
  source!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
