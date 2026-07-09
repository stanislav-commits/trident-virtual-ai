import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One per-ship override of a permission cell (position × resource category).
 * Absence of a row = fall back to the platform DEFAULT_MATRIX (see
 * access-positions.ts). shipId is required — this table only holds vessel
 * overrides; platform defaults live in code, not the DB.
 */
@Entity('access_matrix_cell')
@Unique('UQ_access_cell', ['shipId', 'position', 'resourceCategory'])
export class AccessMatrixCellEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_access_cell_ship')
  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  /** AccessPosition value (matrix column). */
  @Column({ name: 'position', type: 'varchar', length: 32 })
  position!: string;

  /** ResourceCategory value (matrix row). */
  @Column({ name: 'resource_category', type: 'varchar', length: 40 })
  resourceCategory!: string;

  /** PermissionLevel value: none | read | write. */
  @Column({ name: 'level', type: 'varchar', length: 8 })
  level!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
