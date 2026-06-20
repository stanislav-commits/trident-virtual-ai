import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Inventory: spare parts / tools / fluids / consumables, optionally linked
 * to an asset and a PMS task. FKs SET NULL so deleting an asset/task keeps
 * the stock record (just unlinks it).
 */
export class AddInventory20260619000100 implements MigrationInterface {
  name = 'AddInventory20260619000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "inventory_items" (
        "id"           uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ship_id"      uuid NOT NULL,
        "name"         varchar(200) NOT NULL,
        "category"     varchar(16) NOT NULL DEFAULT 'part',
        "part_number"  varchar(120),
        "location"     varchar(160),
        "manufacturer" varchar(160),
        "supplier"     varchar(160),
        "quantity"     numeric(12,2),
        "unit"         varchar(20),
        "asset_id"     uuid,
        "task_id"      uuid,
        "notes"        text,
        "created_at"   timestamptz NOT NULL DEFAULT now(),
        "updated_at"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_inventory_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_inventory_asset" FOREIGN KEY ("asset_id")
          REFERENCES "assets"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_inventory_task" FOREIGN KEY ("task_id")
          REFERENCES "pms_tasks"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_inventory_ship" ON "inventory_items" ("ship_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_inventory_asset" ON "inventory_items" ("asset_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "inventory_items"`);
  }
}
