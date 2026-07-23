import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Defects now carry department + category (set at logging time, same
 * taxonomy as PMS tasks) and a link to the auto-created unplanned PMS task
 * so closing a defect can also complete its task.
 */
export class AddDefectDepartmentTaskLink20260724000300
  implements MigrationInterface
{
  name = 'AddDefectDepartmentTaskLink20260724000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "defects" ADD COLUMN IF NOT EXISTS "department" varchar(16)`,
    );
    await queryRunner.query(
      `ALTER TABLE "defects" ADD COLUMN IF NOT EXISTS "category" varchar(60)`,
    );
    await queryRunner.query(
      `ALTER TABLE "defects" ADD COLUMN IF NOT EXISTS "pms_task_id" uuid REFERENCES "pms_tasks"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "defects" DROP COLUMN IF EXISTS "pms_task_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "defects" DROP COLUMN IF EXISTS "category"`,
    );
    await queryRunner.query(
      `ALTER TABLE "defects" DROP COLUMN IF EXISTS "department"`,
    );
  }
}
