import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record WHO performed a task completion (name + position snapshot). The
 * responsible field is a position (crew rotate), but history should show the
 * actual person who did the work, per the account that completed it.
 */
export class AddPmsTaskCompletedBy20260710000600
  implements MigrationInterface
{
  name = 'AddPmsTaskCompletedBy20260710000600';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN IF NOT EXISTS "completed_by_name" varchar(120)`,
    );
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN IF NOT EXISTS "completed_by_position" varchar(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN IF EXISTS "completed_by_position"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN IF EXISTS "completed_by_name"`,
    );
  }
}
