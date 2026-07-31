import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One vessel or operational event the compliance register reacts to (v60
 * Phase 4): a flag change, a structural alteration, a piece of linked
 * equipment replaced… Recording an event applies its outcome to every
 * current record whose type lists the code in `trigger_codes` — a TO-REVIEW
 * flag, or TO-INVALID for events after which the paper can no longer be
 * relied on. The event row itself is the audit trail of WHY a record was
 * flagged.
 */
@Entity('compliance_events')
@Index('IDX_compliance_events_ship', ['shipId', 'occurredAt'])
export class ComplianceEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  /** Vocabulary code — see COMPLIANCE_EVENT_CODES. */
  @Column({ name: 'code', type: 'varchar', length: 60 })
  code!: string;

  /** manual (operator) | ship (particulars change) | asset | document. */
  @Column({ name: 'source', type: 'varchar', length: 40, default: 'manual' })
  source!: string;

  @Column({ name: 'note', type: 'text', nullable: true })
  note!: string | null;

  /** Narrowing context, e.g. { assetId } for equipment events. */
  @Column({ name: 'payload', type: 'jsonb', nullable: true })
  payload!: Record<string, unknown> | null;

  /** How many records the event flagged / invalidated when applied. */
  @Column({ name: 'affected_count', type: 'integer', default: 0 })
  affectedCount!: number;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy!: string | null;

  @CreateDateColumn({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;
}
