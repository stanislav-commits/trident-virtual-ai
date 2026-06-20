import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Join row linking one inventory item to one asset. An inventory item can be
 * linked to many assets and an asset to many items. FKs (declared in the
 * migration) cascade-delete on either side.
 */
@Entity('inventory_item_assets')
@Index('IDX_inv_item_asset_asset', ['assetId'])
export class InventoryItemAssetEntity {
  @PrimaryColumn({ name: 'inventory_item_id', type: 'uuid' })
  inventoryItemId!: string;

  @PrimaryColumn({ name: 'asset_id', type: 'uuid' })
  assetId!: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt!: Date;
}
