import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Postpone metadata for a maintenance task. Postponing pushes the calendar
 * due date forward and records why/who/when so a chronically deferred task
 * is visible as such. Cleared when the task is next completed (per-cycle):
 *  - postpone_reason    — the crew's "why" (required by the UI)
 *  - postponed_by_name  — snapshot of who postponed it
 *  - postponed_at       — when it was last postponed
 *  - postpone_count     — how many times THIS occurrence has been pushed
 */
export class AddPmsTaskPostpone20260720000300 implements MigrationInterface {
  name = 'AddPmsTaskPostpone20260720000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN IF NOT EXISTS "postpone_reason" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN IF NOT EXISTS "postponed_by_name" varchar(120)`,
    );
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN IF NOT EXISTS "postponed_at" timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN IF NOT EXISTS "postpone_count" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const col of [
      'postpone_count',
      'postponed_at',
      'postponed_by_name',
      'postpone_reason',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "pms_tasks" DROP COLUMN IF EXISTS "${col}"`,
      );
    }
  }
}
