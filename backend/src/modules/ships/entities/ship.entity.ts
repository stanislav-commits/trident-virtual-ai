import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ChatSessionEntity } from '../../chat/entities/chat-session.entity';
import { UserEntity } from '../../users/entities/user.entity';

@Check(`"build_year" IS NULL OR ("build_year" >= 1800 AND "build_year" <= 3000)`)
@Entity('ships')
export class ShipEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Compliance profile — drives which rows of compliance_doc_master apply
   * to this vessel. gt_bucket: lt24 | 24_300 | 300_399 | 400_499 |
   * 500_3000 | gt3000. operation_type: private | commercial.
   * flag_registry: red_ensign | eu | other (nullable = not factored in).
   */
  @Column({ name: 'gt_bucket', type: 'varchar', length: 20, nullable: true })
  gtBucket!: string | null;

  @Column({ name: 'operation_type', type: 'varchar', length: 20, nullable: true })
  operationType!: string | null;

  @Column({ name: 'flag_registry', type: 'varchar', length: 30, nullable: true })
  flagRegistry!: string | null;

  @Column({ name: 'mmsi', type: 'varchar', length: 20, nullable: true })
  mmsi!: string | null;

  @Column({ name: 'call_sign', type: 'varchar', length: 20, nullable: true })
  callSign!: string | null;

  @Column({ name: 'flag', type: 'varchar', length: 80, nullable: true })
  flag!: string | null;

  @Column({ name: 'length_m', type: 'numeric', precision: 6, scale: 2, nullable: true })
  lengthM!: string | null;

  @Column({ name: 'beam_m', type: 'numeric', precision: 6, scale: 2, nullable: true })
  beamM!: string | null;

  @Column({ name: 'depth_m', type: 'numeric', precision: 6, scale: 2, nullable: true })
  depthM!: string | null;

  @Column({ name: 'gross_tonnage', type: 'int', nullable: true })
  grossTonnage!: number | null;

  @Column({ name: 'net_tonnage', type: 'int', nullable: true })
  netTonnage!: number | null;

  /**
   * Vessel master data printed on statutory certificates. Auto-populated into
   * the record form instead of typed onto each certificate.
   * `portOfRegistry` is the legal port on the Certificate of Registry — not
   * `homePort`, which is operational and may differ.
   */
  @Column({ name: 'official_number', type: 'varchar', length: 40, nullable: true })
  officialNumber!: string | null;

  @Column({ name: 'port_of_registry', type: 'varchar', length: 120, nullable: true })
  portOfRegistry!: string | null;

  @Column({ name: 'registered_owner', type: 'varchar', length: 200, nullable: true })
  registeredOwner!: string | null;

  /**
   * The ISM Company (the DOC holder), not the owner — the Document of
   * Compliance and the ISM Code 3.1 declaration are issued to it.
   */
  @Column({ name: 'company_name', type: 'varchar', length: 200, nullable: true })
  companyName!: string | null;

  @Column({ name: 'company_imo_number', type: 'varchar', length: 10, nullable: true })
  companyImoNumber!: string | null;

  @Column({ name: 'shipyard', type: 'varchar', length: 120, nullable: true })
  shipyard!: string | null;

  @Column({ name: 'class_society', type: 'varchar', length: 120, nullable: true })
  classSociety!: string | null;

  /**
   * Which shelves of the publications library this vessel reads, in the
   * library's own vocabulary: "flag:MT", "class:RINA". Kept apart from `flag`
   * and `classSociety`, which are free text a human wrote — retrieval must
   * compare codes, not spellings. Null means "no narrowing": the whole library.
   */
  @Column({ name: 'publication_flag', type: 'varchar', length: 40, nullable: true })
  publicationFlag!: string | null;

  @Column({ name: 'publication_class', type: 'varchar', length: 40, nullable: true })
  publicationClass!: string | null;

  @Column({ name: 'home_port', type: 'varchar', length: 120, nullable: true })
  homePort!: string | null;

  @Column({ name: 'fleet_manager_email', type: 'varchar', length: 160, nullable: true })
  fleetManagerEmail!: string | null;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  @Column({
    name: 'organization_name',
    type: 'varchar',
    length: 255,
    nullable: true,
  })
  organizationName!: string | null;

  @Column({
    name: 'imo_number',
    type: 'varchar',
    length: 7,
    nullable: true,
  })
  imoNumber!: string | null;

  @Column({
    name: 'build_year',
    type: 'integer',
    nullable: true,
  })
  buildYear!: number | null;

  /**
   * Free-text vessel technical profile fed to the metric-analysis AI per ship
   * (propulsion, power generation, naming conventions, side suffixes, quirks).
   * Replaces the old hard-coded SeaWolf X hint — empty = generic, infer from data.
   */
  @Column({ name: 'metric_analysis_hint', type: 'text', nullable: true })
  metricAnalysisHint!: string | null;

  @Column({
    name: 'ragflow_dataset_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  ragflowDatasetId!: string | null;

  /**
   * Marks the single hidden "platform" scope row that owns fleet-wide
   * Publications + their shared RAGFlow dataset. Hidden from ship lists and
   * the vessel switcher; never a navigable vessel. See platform-ship.constants.
   */
  @Column({ name: 'is_platform', type: 'boolean', default: false })
  isPlatform!: boolean;

  /**
   * Vessel photo metadata. The binary is in object storage; the provider is kept
   * per row so a read still works after the storage switch is flipped.
   */
  @Column({ name: 'photo_provider', type: 'varchar', length: 16, nullable: true })
  photoProvider!: string | null;

  @Column({ name: 'photo_mime', type: 'varchar', length: 64, nullable: true })
  photoMime!: string | null;

  @Column({ name: 'photo_updated_at', type: 'timestamptz', nullable: true })
  photoUpdatedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @OneToMany(() => UserEntity, (user) => user.ship)
  users!: UserEntity[];

  @OneToMany(() => ChatSessionEntity, (session) => session.ship)
  chatSessions!: ChatSessionEntity[];
}
