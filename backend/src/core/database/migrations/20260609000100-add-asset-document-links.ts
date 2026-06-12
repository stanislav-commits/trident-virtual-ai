import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Explicit asset ↔ document links. The chat tool still auto-discovers
 * candidate manuals by brand+model match, but admins can now pin specific
 * documents to specific assets through the admin UI — useful when:
 *   • the same manual covers multiple equipment models (one PDF → many assets)
 *   • brand/model fields don't match by string (e.g. document.manufacturer
 *     says "MTU" but asset.brand says "MTU Friedrichshafen")
 *   • the asset has no brand/model filled but a manual is still relevant
 *
 * Both /related and lookup_manual_spec consult this table in addition to
 * the brand/model fuzzy match.
 */
export class AddAssetDocumentLinks20260609000100 implements MigrationInterface {
  name = 'AddAssetDocumentLinks20260609000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "asset_documents" (
        "asset_id"    uuid NOT NULL REFERENCES "assets"("id") ON DELETE CASCADE,
        "document_id" uuid NOT NULL REFERENCES "documents"("id") ON DELETE CASCADE,
        "created_at"  timestamptz NOT NULL DEFAULT now(),
        "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        PRIMARY KEY ("asset_id", "document_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_asset_documents_document" ON "asset_documents" ("document_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_asset_documents_document"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "asset_documents"`);
  }
}
