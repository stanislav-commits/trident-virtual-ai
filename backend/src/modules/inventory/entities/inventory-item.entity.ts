import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * A stockroom item: spare part, tool, fluid or consumable. Optionally linked
 * to one or more assets (via inventory_item_assets) and one or more PMS tasks
 * (via inventory_item_tasks). Ship-scoped.
 */
@Entity('inventory_items')
@Index('IDX_inventory_ship', ['shipId'])
export class InventoryItemEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'ship_id', type: 'uuid' })
  shipId!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  /** part | tool | fluid | consumable | other */
  @Column({ type: 'varchar', length: 16, default: 'part' })
  category!: string;

  @Column({ name: 'part_number', type: 'varchar', length: 120, nullable: true })
  partNumber!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  location!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  manufacturer!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  supplier!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  quantity!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  unit!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
