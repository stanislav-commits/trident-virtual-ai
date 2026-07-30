import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two orthogonal axes on the catalogue: what a document IS
 * (`document_type`, from the Certificate Field Matrix) and how its validity
 * changes (`validity_driver` + `reminder_profile`, from the Certificate
 * Behaviour Matrix). Implementation Rule 1: "Document Type describes what the
 * object is. Validity Driver describes how its status changes. They must remain
 * separate."
 *
 * `archetype` stays alongside for one release. Everything still reads it —
 * field blocks, PMS spec, link roles — and keeping both makes the retype
 * reversible while the new columns are checked against the real register.
 *
 * `library_ref` records which workbook row a catalogue row was matched to, because
 * the mapping is NOT by code: the source renumbered the block, so its 1.6 is our 1.7
 * (energy efficiency) and its 1.7 is our 1.8 (ISM/ISPS/MLC), while our 1.6
 * (MARPOL) has no counterpart at all. Matching by code would have relabelled
 * the IOPP certificate as an energy-efficiency one. The values are loaded by
 * `npm run db:seed:compliance` from the checked-in catalogue snapshot.
 */
export class AddDocumentTypeAxes20260729000600 implements MigrationInterface {
  name = 'AddDocumentTypeAxes20260729000600';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['compliance_doc_master', 'compliance_doc_types']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN IF NOT EXISTS "document_type" varchar(30),
          ADD COLUMN IF NOT EXISTS "validity_driver" varchar(20),
          ADD COLUMN IF NOT EXISTS "reminder_profile" varchar(10),
          ADD COLUMN IF NOT EXISTS "library_ref" varchar(12)
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['compliance_doc_master', 'compliance_doc_types']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN IF EXISTS "document_type",
          DROP COLUMN IF EXISTS "validity_driver",
          DROP COLUMN IF EXISTS "reminder_profile",
          DROP COLUMN IF EXISTS "library_ref"
      `);
    }
  }
}
