import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Distinguish alert sources: 'metric' (Grafana telemetry) vs 'certificate'
 * (compliance-expiry reminders surfaced in the same bell). `compliance_doc_id`
 * links a certificate alert to the compliance record it tracks so it can be
 * resolved when the cert is renewed. Enables the access matrix to gate the two
 * kinds independently (a position can receive alarms, cert reminders, or both).
 */
export class AddAlertSource20260710000100 implements MigrationInterface {
  name = 'AddAlertSource20260710000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "source" varchar(16) NOT NULL DEFAULT 'metric'`,
    );
    await queryRunner.query(
      `ALTER TABLE "alerts" ADD COLUMN IF NOT EXISTS "compliance_doc_id" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_alerts_source" ON "alerts" ("ship_id", "source", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_alerts_source"`);
    await queryRunner.query(
      `ALTER TABLE "alerts" DROP COLUMN IF EXISTS "compliance_doc_id"`,
    );
    await queryRunner.query(`ALTER TABLE "alerts" DROP COLUMN IF EXISTS "source"`);
  }
}
