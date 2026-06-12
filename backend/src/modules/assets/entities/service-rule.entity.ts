import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One maintenance rule for one asset: "Oil + filters every 500 h or 12
 * months". The completion baseline (last_done_*) lives inline — closing a
 * service simply updates these two columns. Verdict computation happens
 * in the chat tool, not in SQL.
 */
@Entity('service_rules')
@Index('IDX_service_rules_ship', ['shipId'])
@Index('IDX_service_rules_asset', ['assetId'])
export class ServiceRuleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  @Column({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'task_name', type: 'varchar', length: 160 })
  taskName!: string;

  // OR-combined triggers ("whichever comes first"); at least one is set
  // (DB CHECK constraint).
  @Column({ name: 'interval_hours', type: 'integer', nullable: true })
  intervalHours!: number | null;

  @Column({ name: 'interval_months', type: 'integer', nullable: true })
  intervalMonths!: number | null;

  @Column({ name: 'last_done_at', type: 'timestamptz', nullable: true })
  lastDoneAt!: Date | null;

  @Column({
    name: 'last_done_runtime_hours',
    type: 'numeric',
    nullable: true,
    transformer: {
      to: (v: number | null) => v,
      from: (v: string | null) => (v === null ? null : parseFloat(v)),
    },
  })
  lastDoneRuntimeHours!: number | null;

  // 'manual' = admin-entered; 'ai_extracted' = parsed from manuals and
  // pending human confirmation before it drives real schedules.
  @Column({ type: 'varchar', length: 20, default: 'manual' })
  source!: string;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
