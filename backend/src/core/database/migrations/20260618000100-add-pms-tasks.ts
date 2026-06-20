import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PMS Tasks — the real backend behind the Tasks admin section and the
 * mobile PMS app. Supersedes the simpler service_rules for scheduling:
 * a task has a calendar schedule (due date + interval) AND/OR a
 * running-hours schedule (interval hours), an assignee, a category, and
 * links to one or more assets (so the asset PMS tab can list its tasks).
 * Status (overdue / due-soon / ok) is derived at read time.
 */
export class AddPmsTasks20260618000100 implements MigrationInterface {
  name = 'AddPmsTasks20260618000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "pms_tasks" (
        "id"               uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ship_id"          uuid NOT NULL REFERENCES "ships"("id") ON DELETE CASCADE,
        "task"             varchar(200) NOT NULL,
        "category"         varchar(24) NOT NULL DEFAULT 'Service',
        "planning"         varchar(12) NOT NULL DEFAULT 'planned',
        "description"      text,
        "sfi_group"        varchar(10),
        "assignee_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "priority"         varchar(12) NOT NULL DEFAULT 'medium',
        "due_date"         date,
        "repeat_date"      boolean NOT NULL DEFAULT false,
        "interval_value"   integer,
        "interval_unit"    varchar(8) NOT NULL DEFAULT 'months',
        "interval_hours"   integer,
        "last_done_hours"  numeric(12,1),
        "last_done_at"     date,
        "completed_at"     timestamptz,
        "source"           varchar(20) NOT NULL DEFAULT 'manual',
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_pms_tasks" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_pms_tasks_ship" ON "pms_tasks" ("ship_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "pms_task_assets" (
        "task_id"  uuid NOT NULL REFERENCES "pms_tasks"("id") ON DELETE CASCADE,
        "asset_id" uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
        CONSTRAINT "PK_pms_task_assets" PRIMARY KEY ("task_id", "asset_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_pms_task_assets_asset" ON "pms_task_assets" ("asset_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "pms_task_assets"`);
    await queryRunner.query(`DROP TABLE "pms_tasks"`);
  }
}
