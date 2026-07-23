import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crew-created metric watches ("следи за баком 5P, скажи когда меньше 15%"):
 * created from the chat, checked every few minutes, surfaced in the
 * Notifications panel when the condition trips. Threshold in display units.
 */
export class AddMetricWatches20260724000100 implements MigrationInterface {
  name = 'AddMetricWatches20260724000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "metric_watches" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "ship_id" uuid NOT NULL,
        "created_by_user_id" uuid,
        "metric_catalog_id" uuid NOT NULL,
        "label" varchar(200) NOT NULL,
        "condition" varchar(8) NOT NULL,
        "threshold" double precision NOT NULL,
        "unit" varchar(32),
        "state" varchar(12) NOT NULL DEFAULT 'ok',
        "last_value" double precision,
        "last_checked_at" timestamptz,
        "triggered_at" timestamptz,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_metric_watches_ship_active" ON "metric_watches" ("ship_id", "is_active")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "metric_watches"`);
  }
}
