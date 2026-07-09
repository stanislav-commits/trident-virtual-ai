import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-metric scaling correction. `scale_factor` multiplies the raw stored value
 * before any consumer (AI analyzer, dashboards, profiler percentiles) reads it,
 * fixing sensors ingested at the wrong magnitude (oil pressure 0.035 → ×100 =
 * 3.5 bar). `scale_source` records origin so a manual admin value beats the
 * profiler's auto-detected one.
 */
export class AddMetricScaleFactor20260703000200 implements MigrationInterface {
  name = 'AddMetricScaleFactor20260703000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ship_metric_catalog" ADD COLUMN "scale_factor" double precision NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "ship_metric_catalog" ADD COLUMN "scale_source" varchar(10) NOT NULL DEFAULT 'default'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ship_metric_catalog" DROP COLUMN IF EXISTS "scale_source"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ship_metric_catalog" DROP COLUMN IF EXISTS "scale_factor"`,
    );
  }
}
