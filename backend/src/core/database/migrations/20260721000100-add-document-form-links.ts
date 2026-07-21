import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Explicit document ↔ document links layered on top of the automatic
 * code-scan match (documents.doc_code / documents.form_refs): an operator
 * can pin a form to a procedure/circular the scanner missed, or SUPPRESS a
 * code match that's wrong — same pinned/excluded idiom as asset_documents.
 * `source_document_id` is always the procedure/circular, `form_document_id`
 * is always the form (enforced in the service, not the DB).
 */
export class AddDocumentFormLinks20260721000100
  implements MigrationInterface
{
  name = 'AddDocumentFormLinks20260721000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "document_form_links" (
        "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "source_document_id"  uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "form_document_id"    uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "link_type"           varchar(12) NOT NULL DEFAULT 'linked',
        "created_at"          timestamptz NOT NULL DEFAULT now(),
        "created_by_user_id"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_document_form_links_type" CHECK ("link_type" IN ('linked', 'excluded')),
        CONSTRAINT "UQ_document_form_links_pair" UNIQUE ("source_document_id", "form_document_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_document_form_links_source" ON "document_form_links" ("source_document_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_document_form_links_form" ON "document_form_links" ("form_document_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_document_form_links_form"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_document_form_links_source"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "document_form_links"`);
  }
}
