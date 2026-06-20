import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Move inventory→asset from a single FK column to a many-to-many join table,
 * so a stock item can belong to several assets. Existing single links are
 * backfilled, then the old "asset_id" column is dropped. Join rows cascade
 * away when either the item or the asset is deleted.
 */
export class AddInventoryItemAssets20260619000200 implements MigrationInterface {
  name = 'AddInventoryItemAssets20260619000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "inventory_item_assets" (
        "inventory_item_id" uuid NOT NULL,
        "asset_id"          uuid NOT NULL,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_inventory_item_assets" PRIMARY KEY ("inventory_item_id", "asset_id"),
        CONSTRAINT "FK_inv_item_asset_item" FOREIGN KEY ("inventory_item_id")
          REFERENCES "inventory_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_inv_item_asset_asset" FOREIGN KEY ("asset_id")
          REFERENCES "assets"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_inv_item_asset_asset" ON "inventory_item_assets" ("asset_id")`,
    );
    // Backfill existing single links.
    await queryRunner.query(`
      INSERT INTO "inventory_item_assets" ("inventory_item_id", "asset_id")
      SELECT "id", "asset_id" FROM "inventory_items" WHERE "asset_id" IS NOT NULL
    `);
    // Retire the single-asset column.
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_inventory_asset"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" DROP CONSTRAINT IF EXISTS "FK_inventory_asset"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" DROP COLUMN IF EXISTS "asset_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ADD COLUMN "asset_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "inventory_items"
        ADD CONSTRAINT "FK_inventory_asset" FOREIGN KEY ("asset_id")
        REFERENCES "assets"("id") ON DELETE SET NULL
    `);
    // Restore one link per item (first by asset id) for rollback completeness.
    await queryRunner.query(`
      UPDATE "inventory_items" i SET "asset_id" = sub."asset_id"
      FROM (
        SELECT DISTINCT ON ("inventory_item_id") "inventory_item_id", "asset_id"
        FROM "inventory_item_assets" ORDER BY "inventory_item_id", "asset_id"
      ) sub
      WHERE i."id" = sub."inventory_item_id"
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_inventory_asset" ON "inventory_items" ("asset_id")`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "inventory_item_assets"`);
  }
}
