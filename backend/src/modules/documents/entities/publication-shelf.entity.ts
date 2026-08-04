import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A shelf in the library rail: a publication (Malta, SOLAS, MARPOL) and one of
 * its categories (Laws and codes, Notices, Forms — or anything the operator
 * names).
 *
 * The rail used to be derived from the nodes themselves, which meant a shelf
 * could not exist until a document was already in it — there was no way to
 * create "Panama → Laws and codes" and then fill it. Shelves are their own
 * rows so the structure can be built first and populated after; the rail is
 * the union of these and whatever categories the nodes actually carry.
 */
@Entity('publication_shelves')
@Unique('UQ_publication_shelf', ['publication', 'category'])
@Index('IDX_publication_shelves_sort', ['sortOrder'])
export class PublicationShelfEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The publication this shelf belongs to — "Malta", "SOLAS", "Lloyd's". */
  @Column({ name: 'publication', type: 'varchar', length: 80 })
  publication!: string;

  /** Free text: the operator names their own categories. */
  @Column({ name: 'category', type: 'varchar', length: 60 })
  category!: string;

  /** international | uk | eu | flag:XX | class:LR — inherited by new nodes. */
  @Column({ name: 'jurisdiction', type: 'varchar', length: 30, nullable: true })
  jurisdiction!: string | null;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
