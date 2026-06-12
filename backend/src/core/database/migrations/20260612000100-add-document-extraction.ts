import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vision-extraction integration: uploaded manuals run through the local
 * vision extractor (trident-manuals pipeline, gpt-4o per page → clean
 * English markdown). The MD becomes what RAGFlow parses (AI reads only
 * the extract); the ORIGINAL PDF stays in the local spool and is what
 * users see when opening the document. The MD itself is admin-only.
 */
export class AddDocumentExtraction20260612000100 implements MigrationInterface {
  name = 'AddDocumentExtraction20260612000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD COLUMN "extraction_status" varchar(16) NOT NULL DEFAULT 'none',
      ADD COLUMN "extracted_md_key" varchar(1024),
      ADD COLUMN "extraction_error" text
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
      DROP COLUMN "extraction_status",
      DROP COLUMN "extracted_md_key",
      DROP COLUMN "extraction_error"
    `);
  }
}
