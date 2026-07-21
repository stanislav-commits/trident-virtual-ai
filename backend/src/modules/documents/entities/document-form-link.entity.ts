import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DocumentEntity } from './document.entity';
import { UserEntity } from '../../users/entities/user.entity';

/**
 * Explicit link between a procedure/circular and a form, layered on top of
 * the automatic code-scan match (doc_code / form_refs). `linkType='linked'`
 * pins a form the scanner missed; `linkType='excluded'` suppresses a code
 * match that's wrong — same pinned/excluded idiom as asset_documents.
 * `sourceDocument` is always the procedure/circular, `formDocument` is
 * always the form (enforced in DocumentsService, not the DB).
 */
@Entity('document_form_links')
@Index('IDX_document_form_links_source', ['sourceDocumentId'])
@Index('IDX_document_form_links_form', ['formDocumentId'])
export class DocumentFormLinkEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'source_document_id', type: 'uuid' })
  sourceDocumentId!: string;

  @Column({ name: 'form_document_id', type: 'uuid' })
  formDocumentId!: string;

  /** 'linked' | 'excluded' */
  @Column({ name: 'link_type', type: 'varchar', length: 12, default: 'linked' })
  linkType!: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @Column({ name: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'source_document_id' })
  sourceDocument!: DocumentEntity;

  @ManyToOne(() => DocumentEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'form_document_id' })
  formDocument!: DocumentEntity;

  @ManyToOne(() => UserEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'created_by_user_id' })
  createdByUser!: UserEntity | null;
}
