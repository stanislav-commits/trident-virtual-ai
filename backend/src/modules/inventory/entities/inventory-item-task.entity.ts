import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Join row linking one inventory item to one PMS task. An item can be used by
 * many tasks (e.g. an impeller in both the 250 h check and the 500 h replace)
 * and a task can need many parts. FKs (in the migration) cascade-delete on
 * either side.
 */
@Entity('inventory_item_tasks')
@Index('IDX_inv_item_task_task', ['taskId'])
export class InventoryItemTaskEntity {
  @PrimaryColumn({ name: 'inventory_item_id', type: 'uuid' })
  inventoryItemId!: string;

  @PrimaryColumn({ name: 'task_id', type: 'uuid' })
  taskId!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
