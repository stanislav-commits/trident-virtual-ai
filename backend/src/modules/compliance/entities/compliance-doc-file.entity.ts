import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DocumentEntity } from '../../documents/entities/document.entity';
import { ComplianceDocEntity } from './compliance-doc.entity';

/**
 * A supporting document attached to a compliance record — a
 * report, checklist, photo, statement or a second certificate that belongs to
 * the same obligation.
 *
 * The parent record keeps its own primary file; these sit alongside it, so a
 * P&I entry can carry the Greek, Italian and Spanish supplements at once
 * (tagged by `label`) and an NWRC entry can carry both the Flag certificate and
 * the insurer evidence (distinguished by `kind`) without either becoming a
 * separate record competing for the type's status.
 */
export const COMPLIANCE_ATTACHMENT_KINDS = [
  'flag_certificate',
  'insurer_evidence',
  'approval_letter',
  'supplement',
  'report',
  'checklist',
  'photo',
  'statement',
  'other',
] as const;

@Entity('compliance_doc_files')
@Index('IDX_compliance_doc_files_doc', ['docId', 'sortOrder'])
export class ComplianceDocFileEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'doc_id', type: 'uuid' })
  docId!: string;

  @ManyToOne(() => ComplianceDocEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'doc_id' })
  doc!: ComplianceDocEntity;

  /** Documents-pipeline file, XOR the directly-stored one below. */
  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId!: string | null;

  @ManyToOne(() => DocumentEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'document_id' })
  document!: DocumentEntity | null;

  @Column({ name: 'file_storage_key', type: 'varchar', length: 400, nullable: true })
  fileStorageKey!: string | null;

  @Column({ name: 'file_name', type: 'varchar', length: 300, nullable: true })
  fileName!: string | null;

  @Column({ name: 'file_mime', type: 'varchar', length: 120, nullable: true })
  fileMime!: string | null;

  /** What this attachment IS — see COMPLIANCE_ATTACHMENT_KINDS. */
  @Column({ name: 'kind', type: 'varchar', length: 40, nullable: true })
  kind!: string | null;

  /**
   * Free tag: jurisdiction on the P&I supplements
   * (1.11.3), vessel name on the MLC repatriation certificates (1.11.6).
   */
  @Column({ name: 'label', type: 'varchar', length: 120, nullable: true })
  label!: string | null;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
