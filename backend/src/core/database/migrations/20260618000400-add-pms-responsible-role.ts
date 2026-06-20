import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * "Who does it" carried from imported PMS sheets — a free-text rank/role
 * (e.g. "Chief Engineer", "2nd Engineer", "Deck"). Distinct from
 * assignee_user_id (a concrete platform user). Phase 5 (Crew + RBAC) will
 * map these roles onto real crew members.
 */
export class AddPmsResponsibleRole20260618000400 implements MigrationInterface {
  name = 'AddPmsResponsibleRole20260618000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN "responsible_role" varchar(80)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN "responsible_role"`,
    );
  }
}
