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

  /** Manufacturer part number — also the import idempotency key. */
  @Column({ name: 'part_number', type: 'varchar', length: 120, nullable: true })
  partNumber!: string | null;

  @Column({ name: 'barcode', type: 'varchar', length: 60, nullable: true })
  barcode!: string | null;

  /** Model / Type line from the source export, e.g. "D13 C1-A". */
  @Column({ name: 'model', type: 'varchar', length: 120, nullable: true })
  model!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  location!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  manufacturer!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  supplier!: string | null;

  /** Supplier's own part number (distinct from the manufacturer's). */
  @Column({ name: 'suppl_part_no', type: 'varchar', length: 120, nullable: true })
  supplPartNo!: string | null;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  quantity!: string | null;

  /** Reorder band: reorder at stock_min, top up to stock_max. */
  @Column({ name: 'stock_min', type: 'numeric', precision: 12, scale: 2, nullable: true })
  stockMin!: string | null;

  @Column({ name: 'stock_max', type: 'numeric', precision: 12, scale: 2, nullable: true })
  stockMax!: string | null;

  /** Unit value in EUR. */
  @Column({ name: 'value_eur', type: 'numeric', precision: 12, scale: 2, nullable: true })
  valueEur!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  unit!: string | null;

  /** SFI group header the item sits under, e.g. "0212 ENGINES". */
  @Column({ name: 'asset_group', type: 'varchar', length: 120, nullable: true })
  assetGroup!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
