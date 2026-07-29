import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clear the false expiry dates the validity-field inference wrote onto REPORT
 * records.
 *
 * `validityField()` used to pick the first date field writing to `compliance`
 * when an archetype had no [AUTH] field. For REPORT that is `report_date` — the
 * date the survey happened — so every report was stored with
 * `expiry_date = report_date`, derived `expired` on the day it was uploaded and
 * raised a critical certificate alert. The inference is gone (REPORT now
 * declares no validity field); this cleans up the rows it already produced.
 *
 * Deliberately narrow: only rows whose expiry is byte-for-byte the stored
 * `report_date`, so an expiry an operator typed in by hand is left alone.
 * Verified on prod 2026-07-29: 6 rows, all matching.
 */
export class ClearReportFalseExpiry20260729000200 implements MigrationInterface {
  name = 'ClearReportFalseExpiry20260729000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "compliance_docs" d
         SET "expiry_date" = NULL
        FROM "compliance_doc_types" t
       WHERE t."id" = d."doc_type_id"
         AND t."archetype" = 'REPORT'
         AND d."expiry_date" IS NOT NULL
         AND d."expiry_date"::text = d."fields"->>'report_date'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "compliance_docs" d
         SET "expiry_date" = (d."fields"->>'report_date')::date
        FROM "compliance_doc_types" t
       WHERE t."id" = d."doc_type_id"
         AND t."archetype" = 'REPORT'
         AND d."expiry_date" IS NULL
         AND d."fields"->>'report_date' IS NOT NULL
    `);
  }
}
