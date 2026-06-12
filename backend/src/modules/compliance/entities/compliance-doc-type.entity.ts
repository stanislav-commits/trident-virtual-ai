import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Rulebook row: one type of compliance document the vessel may need to
 * hold (certificate, plan, report, checklist, licence...). Seeded from
 * Shaun's SFI Master v14.6 Cert_Applicability_Matrix (362 types in 17
 * sections, SFI group 1 numbering), enriched with the renewal-cycle /
 * survey-window / update-trigger logic agreed on 2026-06-11.
 *
 * Per-ship: applicability is resolved for a concrete vessel (GT bucket +
 * operation type), so each ship carries its own copy of the rulebook and
 * JMS can flip a C to Y/N per vessel without touching others.
 */
@Entity('compliance_doc_types')
@Index('IDX_compliance_doc_types_ship_sfi', ['shipId', 'sfiCode'], {
  unique: true,
})
export class ComplianceDocTypeEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  /** e.g. "1.13.25" */
  @Column({ name: 'sfi_code', type: 'varchar', length: 20 })
  sfiCode!: string;

  /** e.g. "1.13" — section prefix for grouping */
  @Column({ name: 'section_code', type: 'varchar', length: 10 })
  sectionCode!: string;

  /** e.g. "LSA & FFA Servicing" */
  @Column({ name: 'section_name', type: 'varchar', length: 120 })
  sectionName!: string;

  @Column({ name: 'name', type: 'varchar', length: 255 })
  name!: string;

  /** vessel | equipment | crew */
  @Column({ name: 'scope', type: 'varchar', length: 20 })
  scope!: string;

  /** SFI code(s) of linked equipment groups, e.g. "08.8.6" */
  @Column({ name: 'linked_sfi', type: 'varchar', length: 60, nullable: true })
  linkedSfi!: string | null;

  /** Y | C | R | N | '' (TBD) — resolved for THIS vessel */
  @Column({ name: 'applicability', type: 'varchar', length: 2 })
  applicability!: string;

  @Column({ name: 'renewal_cycle', type: 'varchar', length: 120, nullable: true })
  renewalCycle!: string | null;

  @Column({ name: 'survey_window', type: 'varchar', length: 160, nullable: true })
  surveyWindow!: string | null;

  /** Event that should make the AI prompt the crew to update this doc. */
  @Column({ name: 'update_trigger', type: 'varchar', length: 200, nullable: true })
  updateTrigger!: string | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
