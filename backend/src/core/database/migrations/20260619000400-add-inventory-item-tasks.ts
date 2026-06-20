import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Move inventory→task from a single FK column to a many-to-many join table, so
 * a part can be linked to several maintenance tasks (and a task can list all
 * its parts). Existing single links are backfilled, then "task_id" is dropped.
 */
export class AddInventoryItemTasks20260619000400 implements MigrationInterface {
  name = 'AddInventoryItemTasks20260619000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "inventory_item_tasks" (
        "inventory_item_id" uuid NOT NULL,
        "task_id"           uuid NOT NULL,
        "created_at"        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_inventory_item_tasks" PRIMARY KEY ("inventory_item_id", "task_id"),
        CONSTRAINT "FK_inv_item_task_item" FOREIGN KEY ("inventory_item_id")
          REFERENCES "inventory_items"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_inv_item_task_task" FOREIGN KEY ("task_id")
          REFERENCES "pms_tasks"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_inv_item_task_task" ON "inventory_item_tasks" ("task_id")`,
    );
    await queryRunner.query(`
      INSERT INTO "inventory_item_tasks" ("inventory_item_id", "task_id")
      SELECT "id", "task_id" FROM "inventory_items" WHERE "task_id" IS NOT NULL
    `);
    await queryRunner.query(
      `ALTER TABLE "inventory_items" DROP CONSTRAINT IF EXISTS "FK_inventory_task"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_items" DROP COLUMN IF EXISTS "task_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "inventory_items" ADD COLUMN "task_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "inventory_items"
        ADD CONSTRAINT "FK_inventory_task" FOREIGN KEY ("task_id")
        REFERENCES "pms_tasks"("id") ON DELETE SET NULL
    `);
    await queryRunner.query(`
      UPDATE "inventory_items" i SET "task_id" = sub."task_id"
      FROM (
        SELECT DISTINCT ON ("inventory_item_id") "inventory_item_id", "task_id"
        FROM "inventory_item_tasks" ORDER BY "inventory_item_id", "task_id"
      ) sub
      WHERE i."id" = sub."inventory_item_id"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "inventory_item_tasks"`);
  }
}
