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
import { DocumentEntity } from './document.entity';

/**
 * One expected fleet-wide publication (COLREGs, SOLAS, MARPOL, IMO codes,
 * Admiralty/ITU references …). This is the Publications Library catalog: the
 * list of publications the platform expects to hold, each a slot to which an
 * admin uploads the actual file later. Fleet-wide (platform scope) — NOT
 * per-ship — so one catalog serves the whole fleet. The uploaded file is a
 * normal `publication`-class document on the platform ship, linked here.
 */
@Entity('publication_catalog')
export class PublicationCatalogEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'title', type: 'varchar', length: 300 })
  title!: string;

  /** Flag/voyage conditionality (e.g. "flag-specific", "if operating polar"). */
  @Column({ name: 'conditional_note', type: 'varchar', length: 120, nullable: true })
  conditionalNote!: string | null;

  // ── Library taxonomy (Regs4Ships load, 2026-08-01). Null on the original
  //    hand-made slots — the UI shows those under "General". ──

  /** Source library section ("SOLAS", "Malta", "LR ShipRight", …). */
  @Index('IDX_publication_catalog_category')
  @Column({ name: 'category', type: 'varchar', length: 80, nullable: true })
  category!: string | null;

  /**
   * Whose rules these are: international | uk | eu | flag:MT… | class:LR.
   * The future flag-scoped retrieval filter keys off this.
   */
  @Column({ name: 'jurisdiction', type: 'varchar', length: 30, nullable: true })
  jurisdiction!: string | null;

  /** Merge-group identity ("MS Notices", "LR-RU-001") — refresh unit. */
  @Column({ name: 'series', type: 'varchar', length: 160, nullable: true })
  series!: string | null;

  /**
   * Newline-joined section headings of the merged document, so the admin
   * search finds "18th Russia Sanctions Package" inside the "MS Notices"
   * slot — the catalog title alone names the bundle, never its pieces.
   */
  @Column({ name: 'contents', type: 'text', nullable: true })
  contents!: string | null;

  @Index('IDX_publication_catalog_sort')
  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  /** The uploaded publication file (null until an admin attaches one). */
  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId!: string | null;

  @ManyToOne(() => DocumentEntity, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'document_id' })
  document!: DocumentEntity | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
