import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Minimal PMS core: per-asset service rules. Deliberately NOT a full
 * work-order system — one table holding "what needs doing and how often",
 * with the last-completion baseline inline. The chat tool `find_pms_due`
 * computes due/overdue verdicts from (current running hours, these rules);
 * a work-order/history layer can grow on top later if the chat surface
 * proves the demand.
 *
 * Triggers are OR-combined like OEM manuals state them ("every 500 h or
 * 12 months, whichever comes first"): either interval column may be NULL.
 */
export class AddServiceRules20260610000200 implements MigrationInterface {
  name = 'AddServiceRules20260610000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "service_rules" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ship_id"       uuid NOT NULL REFERENCES "ships"("id") ON DELETE CASCADE,
        "asset_id"      uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
        "task_name"     varchar(160) NOT NULL,
        "interval_hours"  integer NULL,
        "interval_months" integer NULL,
        "last_done_at"    timestamptz NULL,
        "last_done_runtime_hours" numeric NULL,
        "source"        varchar(20) NOT NULL DEFAULT 'manual',
        "notes"         text NULL,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("id"),
        CONSTRAINT "UQ_service_rules_asset_task" UNIQUE ("asset_id", "task_name"),
        CONSTRAINT "CHK_service_rules_has_interval"
          CHECK ("interval_hours" IS NOT NULL OR "interval_months" IS NOT NULL)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_service_rules_ship" ON "service_rules" ("ship_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_service_rules_asset" ON "service_rules" ("asset_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_service_rules_asset"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_service_rules_ship"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "service_rules"`);
  }
}
