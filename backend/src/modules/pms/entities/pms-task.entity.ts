import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinTable,
  ManyToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AssetEntity } from '../../assets/entities/asset.entity';

/**
 * A planned-maintenance task. Schedules can be calendar-based (dueDate +
 * interval) and/or running-hours-based (intervalHours). Linked to one or
 * more assets via the pms_task_assets junction.
 */
@Entity('pms_tasks')
@Index('IDX_pms_tasks_ship', ['shipId'])
export class PmsTaskEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  @Column({ type: 'varchar', length: 200 })
  task!: string;

  @Column({ type: 'varchar', length: 24, default: 'Service' })
  category!: string;

  /** planned | unplanned */
  @Column({ type: 'varchar', length: 12, default: 'planned' })
  planning!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  // Wide enough for imported group NAMES, not just short SFI codes — the AI
  // maps a source "group name" column here and it overflowed varchar(10).
  @Column({ name: 'sfi_group', type: 'varchar', length: 64, nullable: true })
  sfiGroup!: string | null;

  @Column({ name: 'assignee_user_id', type: 'uuid', nullable: true })
  assigneeUserId!: string | null;

  /** Free-text rank/role from imported sheets ("Chief Engineer", "Deck"). */
  @Column({ name: 'responsible_role', type: 'varchar', length: 80, nullable: true })
  responsibleRole!: string | null;

  /** engine | bridge | ratings | null(general). Drives department gating. */
  @Column({ type: 'varchar', length: 16, nullable: true })
  department!: string | null;

  /** low | medium | high | critical */
  @Column({ type: 'varchar', length: 12, default: 'medium' })
  priority!: string;

  // ── Calendar schedule ──
  @Column({ name: 'due_date', type: 'date', nullable: true })
  dueDate!: string | null;

  /** Calendar anchor: the date the recurring schedule begins (may be future). */
  @Column({ name: 'start_date', type: 'date', nullable: true })
  startDate!: string | null;

  @Column({ name: 'repeat_date', type: 'boolean', default: false })
  repeatDate!: boolean;

  @Column({ name: 'interval_value', type: 'integer', nullable: true })
  intervalValue!: number | null;

  /** days | weeks | months | years */
  @Column({ name: 'interval_unit', type: 'varchar', length: 8, default: 'months' })
  intervalUnit!: string;

  // ── Running-hours schedule ──
  @Column({ name: 'interval_hours', type: 'integer', nullable: true })
  intervalHours!: number | null;

  /** Running-hours baseline: asset hours at which the interval clock starts,
   *  used until the first completion sets last_done_hours. */
  @Column({ name: 'start_hours', type: 'numeric', precision: 12, scale: 1, nullable: true })
  startHours!: string | null;

  @Column({ name: 'last_done_hours', type: 'numeric', precision: 12, scale: 1, nullable: true })
  lastDoneHours!: string | null;

  /** Explicit next-due hours mark (one-off tasks); else computed. */
  @Column({ name: 'due_hours', type: 'numeric', precision: 12, scale: 1, nullable: true })
  dueHours!: string | null;

  @Column({ name: 'last_done_at', type: 'date', nullable: true })
  lastDoneAt!: string | null;

  @Column({ name: 'completed_at', type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  // Who performed the completion — a SNAPSHOT of the name + position at the time
  // (crew rotate; the responsible field is a position, but history records the
  // actual person who did the work).
  @Column({ name: 'completed_by_name', type: 'varchar', length: 120, nullable: true })
  completedByName!: string | null;

  @Column({ name: 'completed_by_position', type: 'varchar', length: 64, nullable: true })
  completedByPosition!: string | null;

  /** Free-text notes from whoever performed the task — distinct from the
   *  job's own `description` (the scheduled instructions). */
  @Column({ name: 'completion_notes', type: 'text', nullable: true })
  completionNotes!: string | null;

  /** OUR permanent human-readable id, e.g. "SWX-M0421" — system-generated. */
  @Column({ name: 'task_code', type: 'varchar', length: 20, nullable: true })
  taskCode!: string | null;

  /** The source PMS's reference id (e.g. "1P231") — import idempotency key. */
  @Column({ name: 'external_ref', type: 'varchar', length: 40, nullable: true })
  externalRef!: string | null;

  @Column({ type: 'varchar', length: 20, default: 'manual' })
  source!: string;

  /**
   * Which board the task lives on:
   *  'maintenance' — equipment upkeep tied to assets (the PMS proper);
   *  'general'     — people-directed work (certificates, drills, assignments).
   */
  @Column({ type: 'varchar', length: 16, default: 'maintenance' })
  board!: string;

  /** When source='compliance', the compliance_docs record that drives this task. */
  @Column({ name: 'source_doc_id', type: 'uuid', nullable: true })
  sourceDocId!: string | null;

  // ── Postpone (calendar deferral with a recorded reason) ──
  /** Why the task was last postponed (required by the UI when postponing). */
  @Column({ name: 'postpone_reason', type: 'text', nullable: true })
  postponeReason!: string | null;

  /** Snapshot of who postponed it. */
  @Column({ name: 'postponed_by_name', type: 'varchar', length: 120, nullable: true })
  postponedByName!: string | null;

  @Column({ name: 'postponed_at', type: 'timestamptz', nullable: true })
  postponedAt!: Date | null;

  /** How many times THIS occurrence has been pushed; reset on completion. */
  @Column({ name: 'postpone_count', type: 'integer', default: 0 })
  postponeCount!: number;

  @ManyToMany(() => AssetEntity, { cascade: false })
  @JoinTable({
    name: 'pms_task_assets',
    joinColumn: { name: 'task_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'asset_id', referencedColumnName: 'id' },
  })
  assets!: AssetEntity[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
