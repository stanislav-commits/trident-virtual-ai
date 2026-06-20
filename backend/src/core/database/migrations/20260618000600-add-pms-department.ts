import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Department a PMS task belongs to (engine | bridge | ratings), for
 * rank-based access (phase 5c). NULL = general/ship-wide, visible to all.
 * Auto-derived from the responsible role on import; editable by admins.
 */
export class AddPmsDepartment20260618000600 implements MigrationInterface {
  name = 'AddPmsDepartment20260618000600';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN "department" varchar(16)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN "department"`,
    );
  }
}
