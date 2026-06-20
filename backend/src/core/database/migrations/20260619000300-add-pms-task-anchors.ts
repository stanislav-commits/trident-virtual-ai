import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schedule anchors for PMS tasks:
 *  - start_date:  calendar anchor — the date the recurring schedule begins.
 *    Lets a task be prepared in advance (asset starts operating later) so the
 *    first due date is computed from this, not from creation time.
 *  - start_hours: running-hours baseline — the asset hours at which the
 *    interval clock starts, used until the first completion sets last_done_hours.
 *    Without it an hours-only task had no baseline, so the hours countdown
 *    never engaged.
 */
export class AddPmsTaskAnchors20260619000300 implements MigrationInterface {
  name = 'AddPmsTaskAnchors20260619000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN "start_date" date`,
    );
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN "start_hours" numeric(12,1)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN IF EXISTS "start_hours"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN IF EXISTS "start_date"`,
    );
  }
}
