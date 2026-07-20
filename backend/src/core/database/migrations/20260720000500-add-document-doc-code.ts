import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SMS↔forms linking by controlled-document code (JMS "EM 002 01" style):
 * - doc_code — the document's OWN code, parsed from its filename (forms &
 *   checklists carry it per the management company's register).
 * - form_refs — codes REFERENCED by this document's text (SMS procedures /
 *   fleet circulars), scanned at upload.
 * A procedure's related forms = forms on the same ship whose doc_code is in
 * the procedure's form_refs — a read-time join, no link table to maintain.
 */
export class AddDocumentDocCode20260720000500 implements MigrationInterface {
  name = 'AddDocumentDocCode20260720000500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "doc_code" character varying(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "form_refs" jsonb`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_documents_ship_doc_code" ON "documents" ("ship_id", "doc_code") WHERE "doc_code" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_documents_ship_doc_code"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN IF EXISTS "form_refs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN IF EXISTS "doc_code"`,
    );
  }
}
