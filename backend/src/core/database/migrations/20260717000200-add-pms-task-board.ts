import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Split the single task list into two boards:
 *  - 'maintenance' — equipment upkeep tied to assets (the PMS proper);
 *  - 'general'     — people-directed work: certificate deadlines, drills,
 *                    personal assignments.
 * Existing compliance-driven tasks are certificate deadlines → 'general';
 * everything else (imported/manual/hours reminders) is maintenance.
 */
export class AddPmsTaskBoard20260717000200 implements MigrationInterface {
  name = 'AddPmsTaskBoard20260717000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN IF NOT EXISTS "board" varchar(16) NOT NULL DEFAULT 'maintenance'`,
    );
    await queryRunner.query(
      `UPDATE "pms_tasks" SET "board" = 'general' WHERE "source" = 'compliance'`,
    );
    // Re-home compliance categories onto the general board's vocabulary so
    // the Tasks board's category filter can find them (renewals arrive as
    // maintenance-taxonomy 'Service').
    await queryRunner.query(
      `UPDATE "pms_tasks" SET "category" = 'Certificate'
       WHERE "source" = 'compliance' AND "category" NOT IN ('Survey', 'Certificate')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN IF EXISTS "board"`,
    );
  }
}
