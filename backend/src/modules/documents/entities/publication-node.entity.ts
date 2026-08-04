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
 * One node of the publications library tree — a self-referencing structure of
 * arbitrary depth, because that is what regulatory material actually looks
 * like: Lloyd's nests set → Part → Chapter → Section, a Malta act is one level
 * of articles, a notice series is a flat run of notices, and a form is a
 * single file with nothing inside it.
 *
 * A node is a container, a leaf, or both — the difference is only whether it
 * has children and whether it carries content. That is what lets "add a
 * section here" work at every level instead of only where a schema anticipated
 * it.
 *
 * Reading the tree:
 *   category + nodeType  — the two-level rail ("Malta" → "Laws and codes")
 *   parentId             — null for a publication root, set for everything else
 *   number + title       — "Part 5" + "Main and auxiliary machinery"
 *   contentText          — the leaf's text, what the AI document is built from
 *   isAiDocument         — this node is assembled into ONE searchable document
 */
@Entity('publication_nodes')
@Index('IDX_publication_nodes_rail', ['category', 'nodeType'])
@Index('IDX_publication_nodes_parent', ['parentId', 'sortOrder'])
export class PublicationNodeEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'parent_id', type: 'uuid', nullable: true })
  parentId!: string | null;

  @ManyToOne(() => PublicationNodeEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'parent_id' })
  parent!: PublicationNodeEntity | null;

  /** Rail level 1 — the shelf a publication sits on ("Malta", "Lloyd's"). */
  @Column({ name: 'category', type: 'varchar', length: 80 })
  category!: string;

  /**
   * Rail level 2, meaningful on roots and inherited by descendants for
   * filtering: 'law' | 'notice_series' | 'form' | 'other'.
   */
  @Column({ name: 'node_type', type: 'varchar', length: 20, default: 'other' })
  nodeType!: string;

  /** Whose rules these are — international | uk | eu | flag:XX | class:LR. */
  @Column({ name: 'jurisdiction', type: 'varchar', length: 30, nullable: true })
  jurisdiction!: string | null;

  /** "Part 5", "Chapter 2", "art. 12", "No. 196" — displayed before the title. */
  @Column({ name: 'number', type: 'varchar', length: 60, nullable: true })
  number!: string | null;

  @Column({ name: 'title', type: 'varchar', length: 400 })
  title!: string;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  /**
   * Leaf content the AI document is assembled from. Held in the DB rather
   * than as 9 662 uploaded files: the text is what retrieval needs, it is
   * cheap to store (~160 MB for the whole library) and it is what the Parse
   * button rewrites when a scan is re-transcribed.
   */
  @Column({ name: 'content_text', type: 'text', nullable: true })
  contentText!: string | null;

  /** The original file, when one is attached (always for forms). */
  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId!: string | null;

  @ManyToOne(() => DocumentEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'document_id' })
  document!: DocumentEntity | null;

  /** Path of the source file in the import library — refresh + Parse use it. */
  @Column({ name: 'source_ref', type: 'varchar', length: 500, nullable: true })
  sourceRef!: string | null;

  /**
   * This node is assembled (with everything under it) into one document in
   * the AI index. Set at the level that reads well: a Part for Lloyd's, a
   * chapter for SOLAS, the act itself for a Malta law.
   */
  @Column({ name: 'is_ai_document', type: 'boolean', default: false })
  isAiDocument!: boolean;

  /** The assembled document in the store, when this node is an AI document. */
  @Column({ name: 'ai_document_id', type: 'uuid', nullable: true })
  aiDocumentId!: string | null;

  /**
   * 0..1 — how much the extracted text looks like language rather than OCR
   * debris. Below 0.7 the node shows "Needs parsing"; images are 0.
   */
  @Column({
    name: 'text_quality',
    type: 'numeric',
    precision: 3,
    scale: 2,
    nullable: true,
  })
  textQuality!: string | null;

  /**
   * none | needed | parsing | parsed | failed | accepted — drives the Parse
   * button and the review queue. "accepted" is a human saying the text is fine
   * despite a low score: the score is a heuristic and a table-heavy page can
   * fail it while reading perfectly.
   */
  @Column({ name: 'parse_state', type: 'varchar', length: 12, default: 'none' })
  parseState!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
