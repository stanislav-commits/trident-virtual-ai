import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The (ship, external_ref) uniqueness enforces "one PLANNED task per source
 * reference id" so re-importing a tasks file upserts instead of duplicating.
 * But a maintenance HISTORY import produces MANY completed rows that all carry
 * the same external_ref (every past completion of ref "1P26"), which is a log,
 * not a schedule. Narrow the unique index to exclude history rows so those
 * completions can coexist while planned tasks stay unique per ref.
 */
export class RelaxExtrefUniqueForHistory20260720000200
  implements MigrationInterface
{
  name = 'RelaxExtrefUniqueForHistory20260720000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_pms_tasks_ship_extref"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pms_tasks_ship_extref"
         ON "pms_tasks" ("ship_id", "external_ref")
         WHERE "external_ref" IS NOT NULL AND "source" <> 'import-history'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_pms_tasks_ship_extref"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pms_tasks_ship_extref"
         ON "pms_tasks" ("ship_id", "external_ref")
         WHERE "external_ref" IS NOT NULL`,
    );
  }
}
