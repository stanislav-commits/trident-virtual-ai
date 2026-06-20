import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Canonical SFI taxonomy — the vessel-agnostic group → sub-group tree loaded
 * from the SFI Master (sheet SFI_Group_Summary). One row per node at any depth
 * (group `3`, sub `3.2`, deeper `3.2.1`). Drives the register's `sfi_group` /
 * `sfi_sub` validation and the cascading group→sub pickers in the admin UI.
 */
@Entity('sfi_taxonomy')
@Index('IDX_sfi_taxonomy_group_level', ['groupCode', 'level'])
export class SfiTaxonomyEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Full dotted code, unique. Group = `3`, sub = `3.2`, deeper = `3.2.1`. */
  @Column({ type: 'varchar', length: 20, unique: true })
  code!: string;

  @Column({ type: 'varchar', length: 255 })
  name!: string;

  /** Number of dotted segments: 1 = group, 2 = sub-group, 3+ = deeper. */
  @Column({ type: 'smallint' })
  level!: number;

  @Column({ name: 'group_code', type: 'varchar', length: 10 })
  groupCode!: string;

  @Column({ name: 'parent_code', type: 'varchar', length: 20, nullable: true })
  parentCode!: string | null;

  @Column({ name: 'default_zone', type: 'varchar', length: 8, nullable: true })
  defaultZone!: string | null;

  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder!: number;

  /** Provenance: 'master' (from SFI Master v14.6) or 'vessel-ext' (codes the
   *  vessel uses that the master template didn't enumerate). */
  @Column({ type: 'varchar', length: 20, default: 'master' })
  source!: string;
}
