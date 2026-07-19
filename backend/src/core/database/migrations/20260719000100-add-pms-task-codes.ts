import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two task identifiers:
 *  - task_code    — OUR permanent human-readable id, e.g. "SWX-M0421"
 *                   (<ship prefix>-<M|G><seq>, M = maintenance board,
 *                   G = general/Tasks board). System-generated on create.
 *  - external_ref — the source PMS's reference id (e.g. "1P231") when a task
 *                   was imported. Idempotency key for re-imports and the join
 *                   key for the maintenance-history import.
 *
 * Backfill: every existing task gets a code — prefix from the ship's asset
 * register (majority "SWX." style prefix), falling back to the ship name's
 * first letters; sequence ordered by created_at per ship+board.
 */
export class AddPmsTaskCodes20260719000100 implements MigrationInterface {
  name = 'AddPmsTaskCodes20260719000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN IF NOT EXISTS "task_code" varchar(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN IF NOT EXISTS "external_ref" varchar(40)`,
    );

    await queryRunner.query(`
      WITH prefixes AS (
        SELECT s.id AS ship_id,
               COALESCE(
                 (SELECT split_part(a.asset_id_internal, '.', 1)
                    FROM assets a
                   WHERE a.ship_id = s.id
                     AND a.asset_id_internal ~ '^[A-Za-z][A-Za-z0-9]*\\.'
                   GROUP BY 1 ORDER BY count(*) DESC LIMIT 1),
                 NULLIF(UPPER(LEFT(regexp_replace(s.name, '[^A-Za-z]', '', 'g'), 3)), ''),
                 'SHIP'
               ) AS prefix
        FROM ships s
      ),
      numbered AS (
        SELECT t.id,
               p.prefix,
               CASE WHEN t.board = 'general' THEN 'G' ELSE 'M' END AS b,
               row_number() OVER (
                 PARTITION BY t.ship_id,
                              CASE WHEN t.board = 'general' THEN 'G' ELSE 'M' END
                 ORDER BY t.created_at, t.id
               ) AS rn
        FROM pms_tasks t
        JOIN prefixes p ON p.ship_id = t.ship_id
        WHERE t.task_code IS NULL
      )
      UPDATE pms_tasks t
         SET task_code = n.prefix || '-' || n.b ||
                         lpad(n.rn::text, greatest(4, length(n.rn::text)), '0')
        FROM numbered n
       WHERE n.id = t.id
    `);

    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pms_tasks_ship_code"
         ON "pms_tasks" ("ship_id", "task_code") WHERE "task_code" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pms_tasks_ship_extref"
         ON "pms_tasks" ("ship_id", "external_ref") WHERE "external_ref" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_pms_tasks_ship_extref"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_pms_tasks_ship_code"`);
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN IF EXISTS "external_ref"`,
    );
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN IF EXISTS "task_code"`,
    );
  }
}
