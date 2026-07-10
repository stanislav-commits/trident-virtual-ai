import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AssetLifecycleStatus } from '../enums/asset-lifecycle-status.enum';

@Entity('assets')
@Index('IDX_assets_ship_id', ['shipId'])
@Index('IDX_assets_asset_id_internal', ['shipId', 'assetIdInternal'])
@Index('IDX_assets_sfi_group', ['shipId', 'sfiGroup'])
@Index('IDX_assets_sfi_sub', ['shipId', 'sfiSub'])
@Index('IDX_assets_lifecycle', ['shipId', 'lifecycleStatus'])
@Index('IDX_assets_parent', ['shipId', 'parentAssetId'])
@Index('IDX_assets_zone', ['shipId', 'zone'])
@Index('IDX_assets_deck_role', ['shipId', 'deckRole'])
@Index('UQ_assets_ship_assetid', ['shipId', 'assetIdInternal'], { unique: true })
export class AssetEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  // Yard / management-issued unique identifier, e.g. "SWX.3.2.1.01-PS".
  // This is the human-facing key the rest of the register references via
  // parent_asset_id / served_by_asset_id / location_asset_id.
  @Column({ name: 'asset_id_internal', type: 'varchar', length: 80 })
  assetIdInternal!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 255 })
  displayName!: string;

  @Column({ name: 'sfi_group', type: 'varchar', length: 10, nullable: true })
  sfiGroup!: string | null;

  @Column({ name: 'sfi_group_name', type: 'varchar', length: 255, nullable: true })
  sfiGroupName!: string | null;

  @Column({ name: 'sfi_sub', type: 'varchar', length: 20, nullable: true })
  sfiSub!: string | null;

  @Column({ name: 'sfi_sub_name', type: 'varchar', length: 255, nullable: true })
  sfiSubName!: string | null;

  /** Source drawing element id (stable per-item key from the register build). */
  @Column({ name: 'drawing_code', type: 'varchar', length: 80, nullable: true })
  drawingCode!: string | null;

  @Column({ name: 'parent_asset_id', type: 'varchar', length: 80, nullable: true })
  parentAssetId!: string | null;

  @Column({ name: 'served_by_asset_id', type: 'varchar', length: 80, nullable: true })
  servedByAssetId!: string | null;

  @Column({ name: 'location_asset_id', type: 'varchar', length: 80, nullable: true })
  locationAssetId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  brand!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  model!: string | null;

  @Column({ name: 'serial_no', type: 'varchar', length: 255, nullable: true })
  serialNo!: string | null;

  @Column({ type: 'smallint', nullable: true })
  criticality!: number | null;

  @Column({
    name: 'lifecycle_status',
    type: 'varchar',
    length: 20,
    default: AssetLifecycleStatus.IN_SERVICE,
  })
  lifecycleStatus!: AssetLifecycleStatus;

  @Column({ name: 'commissioned_date', type: 'date', nullable: true })
  commissionedDate!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  location!: string | null;

  @Column({ name: 'rina_ref', type: 'varchar', length: 100, nullable: true })
  rinaRef!: string | null;

  // ── v14.6 universal location schema ─────────────────────────────────
  // See SFI Master v14.6 Area_Codes_Reference for the controlled vocab:
  // 15 zone codes, 16 deck-role codes, vessel-local space_instance tags.
  // `asset_full_locator` is NOT stored — it's computed in the DTO as
  // `{asset_id_internal} @ {zone}.{deck_role}.{space_instance}`.

  @Column({ type: 'varchar', length: 2, nullable: true })
  zone!: string | null;

  @Column({ name: 'deck_role', type: 'varchar', length: 10, nullable: true })
  deckRole!: string | null;

  @Column({ name: 'deck_level', type: 'smallint', nullable: true })
  deckLevel!: number | null;

  @Column({ name: 'space_instance', type: 'varchar', length: 50, nullable: true })
  spaceInstance!: string | null;

  @Column({ name: 'space_label', type: 'varchar', length: 255, nullable: true })
  spaceLabel!: string | null;

  // ── Maintenance / drawings ──────────────────────────────────────────
  @Column({ name: 'drawing_ref', type: 'varchar', length: 255, nullable: true })
  drawingRef!: string | null;

  @Column({ name: 'inspection_obligation', type: 'text', nullable: true })
  inspectionObligation!: string | null;

  // ── Import provenance (admin audit) ─────────────────────────────────
  @Column({ name: 'parent_auto_populated', type: 'boolean', nullable: true })
  parentAutoPopulated!: boolean | null;

  @Column({
    name: 'criticality_auto_populated',
    type: 'boolean',
    nullable: true,
  })
  criticalityAutoPopulated!: boolean | null;

  @Column({ name: 'source_sheet', type: 'varchar', length: 100, nullable: true })
  sourceSheet!: string | null;

  // ── Vessel-specific overflow (non-canonical v14.6 fields) ──────────
  // Holds rarely-populated or vessel-locale-only fields without forcing
  // a schema migration per field. Examples: asset_voltage_class,
  // served_by_emergency, governing_certs, linked_to_asset_id, id_source,
  // required_minimum_quantity, batch_number.
  @Column({ type: 'jsonb', nullable: true })
  extras!: Record<string, unknown> | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
