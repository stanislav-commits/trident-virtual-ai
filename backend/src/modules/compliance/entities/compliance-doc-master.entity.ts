import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Vessel-agnostic compliance rulebook master — the full applicability
 * matrix from the SFI Master v14.6: one row per document type with Y/C/R/N
 * per GT bucket, operation type and flag. Per-ship rulebooks
 * (compliance_doc_types) are GENERATED from this for a ship's profile, so
 * every new yacht gets its set automatically and matrix updates have one
 * home.
 */
@Entity('compliance_doc_master')
export class ComplianceDocMasterEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'sfi_code', type: 'varchar', length: 20, unique: true })
  sfiCode!: string;

  @Column({ name: 'section_code', type: 'varchar', length: 10 })
  sectionCode!: string;

  @Column({ name: 'section_name', type: 'varchar', length: 120 })
  sectionName!: string;

  @Column({ name: 'name', type: 'varchar', length: 255 })
  name!: string;

  @Column({ name: 'scope', type: 'varchar', length: 20 })
  scope!: string;

  @Column({ name: 'linked_sfi', type: 'varchar', length: 60, nullable: true })
  linkedSfi!: string | null;

  @Column({ name: 'app_lt24', type: 'varchar', length: 2, default: '' })
  appLt24!: string;

  @Column({ name: 'app_24_300', type: 'varchar', length: 2, default: '' })
  app24300!: string;

  @Column({ name: 'app_300_399', type: 'varchar', length: 2, default: '' })
  app300399!: string;

  @Column({ name: 'app_400_499', type: 'varchar', length: 2, default: '' })
  app400499!: string;

  @Column({ name: 'app_500_3000', type: 'varchar', length: 2, default: '' })
  app5003000!: string;

  @Column({ name: 'app_gt3000', type: 'varchar', length: 2, default: '' })
  appGt3000!: string;

  @Column({ name: 'app_private', type: 'varchar', length: 2, default: '' })
  appPrivate!: string;

  @Column({ name: 'app_commercial', type: 'varchar', length: 2, default: '' })
  appCommercial!: string;

  @Column({ name: 'app_yet', type: 'varchar', length: 2, default: '' })
  appYet!: string;

  @Column({ name: 'app_red_ensign', type: 'varchar', length: 2, default: '' })
  appRedEnsign!: string;

  @Column({ name: 'app_eu_flag', type: 'varchar', length: 2, default: '' })
  appEuFlag!: string;

  @Column({ name: 'app_other_flag', type: 'varchar', length: 2, default: '' })
  appOtherFlag!: string;

  @Column({ name: 'renewal_cycle', type: 'varchar', length: 120, nullable: true })
  renewalCycle!: string | null;

  @Column({ name: 'survey_window', type: 'varchar', length: 160, nullable: true })
  surveyWindow!: string | null;

  @Column({ name: 'update_trigger', type: 'varchar', length: 200, nullable: true })
  updateTrigger!: string | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;

  // ── Doc-control schema v9: archetype tagging ──

  /** One of 11 archetypes (STAT_CERT, EQUIP_SVC, …) — selects the field set. */
  @Column({ name: 'archetype', type: 'varchar', length: 16, nullable: true })
  archetype!: string | null;

  /** vessel | single_asset | per_unit | sub_group | person. */
  @Column({ name: 'link_cardinality', type: 'varchar', length: 16, nullable: true })
  linkCardinality!: string | null;

  /** Recognised mandating instrument (SOLAS/MARPOL/ISM…); blank for commercial. */
  @Column({ name: 'reg_basis', type: 'varchar', length: 200, nullable: true })
  regBasis!: string | null;

  /** Plain-English reason the document exists. */
  @Column({ name: 'basis_note', type: 'text', nullable: true })
  basisNote!: string | null;

  /** What PMS behaviour it drives (survey/renewal/corrections/NC close-out…). */
  @Column({ name: 'drives_pms', type: 'varchar', length: 40, nullable: true })
  drivesPms!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
