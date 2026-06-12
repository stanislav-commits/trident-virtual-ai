import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { DocumentEntity } from '../../documents/entities/document.entity';
import { UserEntity } from '../../users/entities/user.entity';
import { AssetEntity } from './asset.entity';

/**
 * Explicit link between an asset and a manual / document. The chat tools
 * also auto-discover candidate manuals via brand/model fuzzy match — this
 * table layers human-curated links on top so admins can pin documents that
 * the fuzzy match misses (or unpin auto-matched ones that don't apply).
 *
 * Composite PK (asset_id, document_id) so the same document can be linked
 * to many assets and a single asset can have many manuals — but the same
 * pair cannot be inserted twice.
 */
@Entity('asset_documents')
@Index('IDX_asset_documents_document', ['documentId'])
export class AssetDocumentLinkEntity {
  @PrimaryColumn({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @PrimaryColumn({ name: 'document_id', type: 'uuid' })
  documentId!: string;

  @ManyToOne(() => AssetEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'asset_id' })
  asset!: AssetEntity;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({ name: 'document_id' })
  document!: DocumentEntity;

  /**
   * 'pinned'   — explicit human link (default, the original semantics).
   * 'excluded' — suppression of a brand/model auto-match that does not
   *              apply to this asset; the related-documents view and chat
   *              matching must skip the document for this asset.
   */
  @Column({ name: 'link_type', type: 'varchar', length: 16, default: 'pinned' })
  linkType!: 'pinned' | 'excluded';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser!: UserEntity | null;
}
