import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Version / history model for compliance records, plus the catalogue policies
 * that drive it (the certificate behaviour matrix).
 *
 * Today a renewal is simply a second row under the same type, and typeStatus
 * takes the WORST status across every row — so a certificate that was renewed
 * stays red for as long as the superseded copy is kept. The only way out was to
 * delete history, which `deleteDoc` did permanently, file and extracted text
 * included.
 *
 * Policy defaults follow the matrix: One Current Version Yes in 100 of 108
 * rows, Retain History Yes in 105. The rows that say "No" are almost all
 * SURVEY_REPORT — annual test reports where each event is its own record — so
 * our REPORT archetype is seeded false. mandatory_upload defaults false: the
 * matrix splits 66 Yes / 29 No / 12 Conditional, and defaulting it true would
 * start rejecting saves that work today.
 *
 * DELIBERATELY NO BACKFILL. 30 types on production hold more than one record,
 * but only 24 of them are versions: 1.14.1 (crane) holds 7 records across 4
 * different assets and 1.13.6 (BA cylinders) 4 across 3 — those are coverage,
 * not revisions, and auto-superseding by date would have hidden real per-unit
 * certificates. Everything is left `current`; the status rule distinguishes the
 * two cases by link target instead of guessing, and superseding is an explicit
 * operator action.
 */
export class AddComplianceVersioning20260729000400 implements MigrationInterface {
  name = 'AddComplianceVersioning20260729000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "compliance_docs"
        ADD COLUMN IF NOT EXISTS "record_state" varchar(12) NOT NULL DEFAULT 'current',
        ADD COLUMN IF NOT EXISTS "revision" integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS "supersedes_doc_id" uuid,
        ADD COLUMN IF NOT EXISTS "superseded_by_doc_id" uuid,
        ADD COLUMN IF NOT EXISTS "archived_at" timestamptz
    `);
    await queryRunner.query(`
      ALTER TABLE "compliance_docs"
        DROP CONSTRAINT IF EXISTS "FK_compliance_docs_supersedes",
        ADD CONSTRAINT "FK_compliance_docs_supersedes"
          FOREIGN KEY ("supersedes_doc_id") REFERENCES "compliance_docs"("id")
          ON DELETE SET NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "compliance_docs"
        DROP CONSTRAINT IF EXISTS "FK_compliance_docs_superseded_by",
        ADD CONSTRAINT "FK_compliance_docs_superseded_by"
          FOREIGN KEY ("superseded_by_doc_id") REFERENCES "compliance_docs"("id")
          ON DELETE SET NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_compliance_docs_state"
        ON "compliance_docs" ("ship_id", "doc_type_id", "record_state")
    `);

    for (const table of ['compliance_doc_master', 'compliance_doc_types']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN IF NOT EXISTS "one_current_version" boolean NOT NULL DEFAULT true,
          ADD COLUMN IF NOT EXISTS "retain_history" boolean NOT NULL DEFAULT true,
          ADD COLUMN IF NOT EXISTS "auto_archive_previous" boolean NOT NULL DEFAULT true,
          ADD COLUMN IF NOT EXISTS "mandatory_upload" boolean NOT NULL DEFAULT false
      `);
      await queryRunner.query(`
        UPDATE "${table}" SET "one_current_version" = false WHERE "archetype" = 'REPORT'
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['compliance_doc_master', 'compliance_doc_types']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN IF EXISTS "one_current_version",
          DROP COLUMN IF EXISTS "retain_history",
          DROP COLUMN IF EXISTS "auto_archive_previous",
          DROP COLUMN IF EXISTS "mandatory_upload"
      `);
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_compliance_docs_state"`);
    await queryRunner.query(`
      ALTER TABLE "compliance_docs"
        DROP CONSTRAINT IF EXISTS "FK_compliance_docs_supersedes",
        DROP CONSTRAINT IF EXISTS "FK_compliance_docs_superseded_by",
        DROP COLUMN IF EXISTS "record_state",
        DROP COLUMN IF EXISTS "revision",
        DROP COLUMN IF EXISTS "supersedes_doc_id",
        DROP COLUMN IF EXISTS "superseded_by_doc_id",
        DROP COLUMN IF EXISTS "archived_at"
    `);
  }
}
