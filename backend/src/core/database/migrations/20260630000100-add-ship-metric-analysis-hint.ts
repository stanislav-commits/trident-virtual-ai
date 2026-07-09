import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds ships.metric_analysis_hint — a free-text per-vessel technical profile
 * fed to the metric-analysis AI (propulsion, gensets, naming conventions).
 * Replaces the previously hard-coded SeaWolf X hint so any vessel is analysed
 * with its own profile (empty = generic, infer from the data).
 */
export class AddShipMetricAnalysisHint20260630000100
  implements MigrationInterface
{
  name = 'AddShipMetricAnalysisHint20260630000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ships" ADD COLUMN IF NOT EXISTS "metric_analysis_hint" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ships" DROP COLUMN IF EXISTS "metric_analysis_hint"`,
    );
  }
}
