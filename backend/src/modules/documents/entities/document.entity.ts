import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  ValueTransformer,
} from 'typeorm';
import { ShipEntity } from '../../ships/entities/ship.entity';
import { UserEntity } from '../../users/entities/user.entity';
import { DocumentChunkMethod } from '../enums/document-chunk-method.enum';
import { DocumentDocClass } from '../enums/document-doc-class.enum';
import { DocumentParseProfile } from '../enums/document-parse-profile.enum';
import { DocumentParseStatus } from '../enums/document-parse-status.enum';
import { DocumentTimeScope } from '../enums/document-time-scope.enum';

const bigintNumberTransformer: ValueTransformer = {
  to: (value: number) => value,
  from: (value: string | number) => Number(value),
};

const nullableDecimalNumberTransformer: ValueTransformer = {
  to: (value: number | null) => value,
  from: (value: string | number | null) =>
    value === null || value === undefined ? null : Number(value),
};

@Entity('documents')
@Index('IDX_documents_ship_created', ['shipId', 'createdAt'])
@Index('IDX_documents_ship_checksum', ['shipId', 'checksumSha256'])
@Index('IDX_documents_ship_doc_class', ['shipId', 'docClass'])
@Index('IDX_documents_ship_parse_status', ['shipId', 'parseStatus'])
@Index('IDX_documents_ragflow_document', ['ragflowDatasetId', 'ragflowDocumentId'])
export class DocumentEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  @ManyToOne(() => ShipEntity, {
    nullable: false,
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'ship_id' })
  ship!: ShipEntity;

  @Column({ name: 'uploaded_by_user_id', type: 'uuid', nullable: true })
  uploadedByUserId!: string | null;

  @ManyToOne(() => UserEntity, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'uploaded_by_user_id' })
  uploadedByUser!: UserEntity | null;

  @Column({ name: 'original_file_name', type: 'varchar', length: 512 })
  originalFileName!: string;

  @Column({ name: 'storage_key', type: 'varchar', length: 1024, nullable: true })
  storageKey!: string | null;

  @Column({ name: 'mime_type', type: 'varchar', length: 255 })
  mimeType!: string;

  @Column({
    name: 'file_size_bytes',
    type: 'bigint',
    transformer: bigintNumberTransformer,
  })
  fileSizeBytes!: number;

  @Column({ name: 'checksum_sha256', type: 'char', length: 64 })
  checksumSha256!: string;

  @Column({ name: 'page_count', type: 'integer', nullable: true })
  pageCount!: number | null;

  @Column({ name: 'ragflow_document_id', type: 'varchar', length: 128, nullable: true })
  ragflowDocumentId!: string | null;

  @Column({ name: 'ragflow_dataset_id', type: 'varchar', length: 128, nullable: true })
  ragflowDatasetId!: string | null;

  @Column({
    name: 'doc_class',
    type: 'enum',
    enum: DocumentDocClass,
    enumName: 'document_doc_class_enum',
  })
  docClass!: DocumentDocClass;

  @Column({ type: 'varchar', length: 32, nullable: true })
  language!: string | null;

  @Column({ name: 'equipment_or_system', type: 'varchar', length: 255, nullable: true })
  equipmentOrSystem!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  manufacturer!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  model!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  revision!: string | null;

  @Column({
    name: 'time_scope',
    type: 'enum',
    enum: DocumentTimeScope,
    enumName: 'document_time_scope_enum',
    default: DocumentTimeScope.CURRENT,
  })
  timeScope!: DocumentTimeScope;

  @Column({ name: 'source_priority', type: 'integer', default: 100 })
  sourcePriority!: number;

  @Column({ name: 'content_focus', type: 'varchar', length: 100, nullable: true })
  contentFocus!: string | null;

  @Column({
    name: 'parse_profile',
    type: 'enum',
    enum: DocumentParseProfile,
    enumName: 'document_parse_profile_enum',
  })
  parseProfile!: DocumentParseProfile;

  @Column({
    name: 'chunk_method',
    type: 'enum',
    enum: DocumentChunkMethod,
    enumName: 'document_chunk_method_enum',
  })
  chunkMethod!: DocumentChunkMethod;

  @Column({ name: 'pdf_parser', type: 'varchar', length: 64 })
  pdfParser!: string;

  @Column({ name: 'auto_keywords', type: 'integer' })
  autoKeywords!: number;

  @Column({ name: 'auto_questions', type: 'integer' })
  autoQuestions!: number;

  @Column({ name: 'chunk_size', type: 'integer', nullable: true })
  chunkSize!: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  delimiter!: string | null;

  @Column({ name: 'overlap_percent', type: 'integer', nullable: true })
  overlapPercent!: number | null;

  @Column({ name: 'page_index_enabled', type: 'boolean', default: false })
  pageIndexEnabled!: boolean;

  @Column({ name: 'child_chunks_enabled', type: 'boolean', default: false })
  childChunksEnabled!: boolean;

  @Column({ name: 'image_table_context_window', type: 'integer', nullable: true })
  imageTableContextWindow!: number | null;

  @Column({
    name: 'parse_status',
    type: 'enum',
    enum: DocumentParseStatus,
    enumName: 'document_parse_status_enum',
    default: DocumentParseStatus.UPLOADED,
  })
  parseStatus!: DocumentParseStatus;

  @Column({ name: 'parse_error', type: 'text', nullable: true })
  parseError!: string | null;

  @Column({
    name: 'parse_progress_percent',
    type: 'numeric',
    precision: 6,
    scale: 2,
    nullable: true,
    transformer: nullableDecimalNumberTransformer,
  })
  parseProgressPercent!: number | null;

  @Column({ name: 'chunk_count', type: 'integer', nullable: true })
  chunkCount!: number | null;

  @Column({ name: 'parsed_at', type: 'timestamptz', nullable: true })
  parsedAt!: Date | null;

  @Column({ name: 'last_synced_at', type: 'timestamptz', nullable: true })
  lastSyncedAt!: Date | null;

  @Column({ name: 'metadata_json', type: 'jsonb', nullable: true })
  metadataJson!: Record<string, unknown> | null;

  @Column({ name: 'parser_config_json', type: 'jsonb', nullable: true })
  parserConfigJson!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
