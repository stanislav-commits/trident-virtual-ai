import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Supporting documents attached to a compliance record:
 * "Supporting Documents should link reports, checklists, photos and statements
 * to a parent certificate without forcing each file to become a separate
 * certificate record."
 *
 * A record could hold exactly one file, so every extra piece of paper had to
 * become its own record under the same type — which then competed with the
 * certificate for the type's status. The review notes name four places this
 * breaks:
 *
 *   1.11.3  merge the Greece / Italy / Spain P&I supplements into one entry and
 *           "tag each attachment by jurisdiction"
 *   1.11.6  "allow multiple vessel-specific attachments"
 *   1.11.8  keep the Malta Flag certificate and the British Marine insurer
 *           evidence under one record, "identify attachment type as Flag
 *           Certificate or Insurer Evidence"
 *   1.12.1  keep the USCG-approved plan and its approval letter together
 *
 * Hence `kind` (what the attachment is) and `label` (the free tag the notes ask
 * for — jurisdiction, vessel name). The record's own `document_id` /
 * `file_storage_key` stay as the primary document; these are supporting.
 *
 * File storage mirrors compliance_docs: either a documents-pipeline id or a
 * directly-stored object key, never both.
 */
export class AddComplianceDocFiles20260729000500 implements MigrationInterface {
  name = 'AddComplianceDocFiles20260729000500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "compliance_doc_files" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "doc_id" uuid NOT NULL,
        "document_id" uuid,
        "file_storage_key" varchar(400),
        "file_name" varchar(300),
        "file_mime" varchar(120),
        "kind" varchar(40),
        "label" varchar(120),
        "sort_order" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_compliance_doc_files" PRIMARY KEY ("id"),
        CONSTRAINT "FK_compliance_doc_files_doc" FOREIGN KEY ("doc_id")
          REFERENCES "compliance_docs"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_compliance_doc_files_document" FOREIGN KEY ("document_id")
          REFERENCES "documents"("id") ON DELETE SET NULL,
        CONSTRAINT "CHK_compliance_doc_files_one_source" CHECK (
          ("document_id" IS NOT NULL) <> ("file_storage_key" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_compliance_doc_files_doc"
        ON "compliance_doc_files" ("doc_id", "sort_order")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_compliance_doc_files_doc"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "compliance_doc_files"`);
  }
}
