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

  // ── Doc-control schema v9: archetype tagging (copied from master) ──

  @Column({ name: 'archetype', type: 'varchar', length: 16, nullable: true })
  archetype!: string | null;

  @Column({ name: 'link_cardinality', type: 'varchar', length: 16, nullable: true })
  linkCardinality!: string | null;

  @Column({ name: 'reg_basis', type: 'varchar', length: 200, nullable: true })
  regBasis!: string | null;

  @Column({ name: 'basis_note', type: 'text', nullable: true })
  basisNote!: string | null;

  @Column({ name: 'drives_pms', type: 'varchar', length: 40, nullable: true })
  drivesPms!: string | null;

  /**
   * Version policy (v60 Certificate Behaviour Matrix). `oneCurrentVersion`
   * decides whether a new issue supersedes the previous one for the same
   * target; `retainHistory` whether a withdrawn record is archived instead of
   * deleted; `autoArchivePrevious` whether superseding happens without asking.
   */
  @Column({ name: 'one_current_version', type: 'boolean', default: true })
  oneCurrentVersion!: boolean;

  @Column({ name: 'retain_history', type: 'boolean', default: true })
  retainHistory!: boolean;

  @Column({ name: 'auto_archive_previous', type: 'boolean', default: true })
  autoArchivePrevious!: boolean;

  @Column({ name: 'mandatory_upload', type: 'boolean', default: false })
  mandatoryUpload!: boolean;

  /**
   * v60 axes. `documentType` is what the document IS (Certificate Field
   * Matrix); `validityDriver` + `reminderProfile` are how its status changes
   * (Certificate Behaviour Matrix) — Rule 1 keeps them separate. Null on rows
   * the workbook does not cover (all of MARPOL, most of 1.12, and everything
   * from 1.13 on, which leaves the register). `v60Ref` is the workbook row this
   * one was matched to: the mapping is by NAME, never by code, because v60
   * renumbered the 1.6/1.7/1.8 block.
   */
  @Column({ name: 'document_type', type: 'varchar', length: 30, nullable: true })
  documentType!: string | null;

  @Column({ name: 'validity_driver', type: 'varchar', length: 20, nullable: true })
  validityDriver!: string | null;

  @Column({ name: 'reminder_profile', type: 'varchar', length: 10, nullable: true })
  reminderProfile!: string | null;

  @Column({ name: 'v60_ref', type: 'varchar', length: 12, nullable: true })
  v60Ref!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
