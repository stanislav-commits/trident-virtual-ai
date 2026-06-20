import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AssetEntity } from '../../assets/entities/asset.entity';
import { CrewMemberEntity } from '../../crew/entities/crew-member.entity';
import { ComplianceDocEntity } from './compliance-doc.entity';

/**
 * Link_Model (doc-control schema v9): one compliance document ↔ many assets
 * (or a crew member, for PERSONNEL docs). Exactly one of asset_id /
 * crew_member_id is set (DB CHECK constraint).
 */
@Entity('doc_asset_links')
@Index('IDX_dal_doc', ['docId'])
@Index('IDX_dal_asset', ['assetId'])
export class DocAssetLinkEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'doc_id', type: 'uuid' })
  docId!: string;

  @ManyToOne(() => ComplianceDocEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'doc_id' })
  doc?: ComplianceDocEntity;

  @Column({ name: 'asset_id', type: 'uuid', nullable: true })
  assetId!: string | null;

  @ManyToOne(() => AssetEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'asset_id' })
  asset?: AssetEntity | null;

  @Column({ name: 'crew_member_id', type: 'uuid', nullable: true })
  crewMemberId!: string | null;

  @ManyToOne(() => CrewMemberEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'crew_member_id' })
  crewMember?: CrewMemberEntity | null;

  /** SFI group.sub used to resolve the link (audit trail). */
  @Column({ name: 'resolution_sfi', type: 'varchar', length: 60, nullable: true })
  resolutionSfi!: string | null;

  /** certifies | services | type_approves | documents | covers */
  @Column({ name: 'link_role', type: 'varchar', length: 16, default: 'covers' })
  linkRole!: string;

  /** system_generated | extracted_serial | manual_confirm */
  @Column({ name: 'match_method', type: 'varchar', length: 20, default: 'manual_confirm' })
  matchMethod!: string;

  /** auto | confirmed (per link) */
  @Column({ name: 'verify_state', type: 'varchar', length: 12, default: 'confirmed' })
  verifyState!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
