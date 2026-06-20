import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asset running-hours model (PMS phase 2). An asset's current hours can
 * come from three sources:
 *   metric_direct  — a dedicated running-hours counter metric (read last)
 *   metric_derived — derived from a power metric: baseline_hours + runtime
 *                    (time the metric exceeded running_threshold) since
 *                    baseline_at (watermaker via active power; the metric
 *                    only sees runtime from its connection date, so the
 *                    baseline carries the hours run before that)
 *   manual         — a local counter the user reads periodically; the
 *                    latest reading is the current hours
 */
export class AddAssetHours20260618000300 implements MigrationInterface {
  name = 'AddAssetHours20260618000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "asset_hours_config" (
        "asset_id"          uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
        "ship_id"           uuid NOT NULL REFERENCES "ships"("id") ON DELETE CASCADE,
        "source"            varchar(16) NOT NULL DEFAULT 'none',
        "metric_catalog_id" uuid REFERENCES "ship_metric_catalog"("id") ON DELETE SET NULL,
        "baseline_hours"    numeric(12,1),
        "baseline_at"       timestamptz,
        "running_threshold" numeric(12,2) NOT NULL DEFAULT 0,
        "updated_at"        timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_asset_hours_config" PRIMARY KEY ("asset_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_asset_hours_config_ship" ON "asset_hours_config" ("ship_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "asset_hour_readings" (
        "id"         uuid NOT NULL DEFAULT uuid_generate_v4(),
        "asset_id"   uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
        "ship_id"    uuid NOT NULL REFERENCES "ships"("id") ON DELETE CASCADE,
        "hours"      numeric(12,1) NOT NULL,
        "read_on"    date NOT NULL,
        "note"       text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_asset_hour_readings" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_asset_hour_readings_asset" ON "asset_hour_readings" ("asset_id", "read_on")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "asset_hour_readings"`);
    await queryRunner.query(`DROP TABLE "asset_hours_config"`);
  }
}
