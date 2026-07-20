import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extra stock fields carried by the real PMS "Inventory List" / "Items By
 * Storage Area" exports, so the inventory importer can round-trip them:
 *  - barcode         — scan code printed on the bin/label
 *  - model           — the Model/Type line (e.g. "D13 C1-A")
 *  - suppl_part_no   — the supplier's own part number (distinct from the
 *                      manufacturer part number already held in part_number)
 *  - stock_min/max   — the reorder band ("Min / Max")
 *  - value_eur       — unit value
 *  - asset_group     — the SFI group header the item sits under ("0212 ENGINES")
 *
 * part_number keeps holding the MANUFACTURER part number — it is the import
 * idempotency key (upsert by (ship, part_number)); a non-unique index speeds
 * that lookup. No unique constraint: task-import may already have produced
 * rows sharing a number, and idempotency is enforced in the commit code.
 */
export class AddInventoryImportFields20260720000100
  implements MigrationInterface
{
  name = 'AddInventoryImportFields20260720000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "barcode" varchar(60)`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "model" varchar(120)`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "suppl_part_no" varchar(120)`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "stock_min" numeric(12,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "stock_max" numeric(12,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "value_eur" numeric(12,2)`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "asset_group" varchar(120)`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_inventory_ship_partno"
         ON "inventory_items" ("ship_id", "part_number")
         WHERE "part_number" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_inventory_ship_partno"`,
    );
    for (const col of [
      'asset_group',
      'value_eur',
      'stock_max',
      'stock_min',
      'suppl_part_no',
      'model',
      'barcode',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "inventory_items" DROP COLUMN IF EXISTS "${col}"`,
      );
    }
  }
}
