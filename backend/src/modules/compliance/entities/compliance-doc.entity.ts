import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { AssetEntity } from '../../assets/entities/asset.entity';
import { DocumentEntity } from '../../documents/entities/document.entity';
import { ComplianceDocTypeEntity } from './compliance-doc-type.entity';

/**
 * A concrete compliance record held by the vessel: one issued certificate,
 * approved plan, service report, licence... belonging to a rulebook type.
 *
 * One type can have MANY records: renewal history, or one record per unit
 * for equipment-scope types (each liferaft has its own annual inspection
 * cert — Shaun's LSA case). `assetId` links a record to the concrete unit;
 * `documentId` links to the uploaded PDF in the documents/RAGFlow store.
 *
 * Status is NOT stored — it is derived at read time from expiryDate
 * (MISSING handled at type level when no records exist):
 *   EXPIRED  expiry < today
 *   EXPIRING expiry within 90 days
 *   VALID    otherwise (or no expiry for permanent docs)
 */
@Entity('compliance_docs')
@Index('IDX_compliance_docs_ship', ['shipId'])
@Index('IDX_compliance_docs_type', ['docTypeId'])
@Index('IDX_compliance_docs_asset', ['assetId'])
export class ComplianceDocEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  @Column({ name: 'doc_type_id', type: 'uuid' })
  docTypeId!: string;

  @ManyToOne(() => ComplianceDocTypeEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'doc_type_id' })
  docType!: ComplianceDocTypeEntity;

  @Column({ name: 'cert_no', type: 'varchar', length: 120, nullable: true })
  certNo!: string | null;

  @Column({ name: 'issuer', type: 'varchar', length: 160, nullable: true })
  issuer!: string | null;

  @Column({ name: 'issue_date', type: 'date', nullable: true })
  issueDate!: string | null;

  @Column({ name: 'expiry_date', type: 'date', nullable: true })
  expiryDate!: string | null;

  /** Equipment-scope link: which unit this record certifies. */
  @Column({ name: 'asset_id', type: 'uuid', nullable: true })
  assetId!: string | null;

  @ManyToOne(() => AssetEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'asset_id' })
  asset!: AssetEntity | null;

  /** Uploaded PDF in the documents store (and thus RAGFlow). */
  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId!: string | null;

  @ManyToOne(() => DocumentEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'document_id' })
  document!: DocumentEntity | null;

  @Column({ name: 'notes', type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
