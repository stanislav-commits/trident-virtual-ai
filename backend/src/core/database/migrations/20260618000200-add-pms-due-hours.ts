import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Explicit next-due running-hours mark. Recurring tasks compute it from
 * lastDoneHours + intervalHours, but a one-off "do this at N hours" task
 * sets it directly. Stored so both cases are first-class.
 */
export class AddPmsDueHours20260618000200 implements MigrationInterface {
  name = 'AddPmsDueHours20260618000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN "due_hours" numeric(12,1)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "pms_tasks" DROP COLUMN "due_hours"`);
  }
}
