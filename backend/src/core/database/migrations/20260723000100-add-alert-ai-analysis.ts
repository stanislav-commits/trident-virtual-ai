import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AI root-cause analysis attached to an alert. When a critical/high metric
 * alarm fires, the metric-analyzer agent investigates it automatically
 * (trend around the trigger, correlated metrics, recurrence history) and the
 * result is stored here, shown in the Notifications panel:
 *  - ai_analysis     — the analyzer's answer (markdown)
 *  - ai_analyzed_at  — when the analysis completed
 */
export class AddAlertAiAnalysis20260723000100 implements MigrationInterface {
  name = 'AddAlertAiAnalysis20260723000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "ai_analysis" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "ai_analyzed_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "alerts" DROP COLUMN IF EXISTS "ai_analyzed_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "alerts" DROP COLUMN IF EXISTS "ai_analysis"`,
    );
  }
}
