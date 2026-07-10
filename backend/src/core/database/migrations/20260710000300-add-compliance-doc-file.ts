import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Store the original file directly on a compliance doc for docs ingested via
 * the AI batch path (which does not go through the documents/RAGFlow pipeline
 * and so has no document_id). Enables file preview from the compliance list.
 */
export class AddComplianceDocFile20260710000300 implements MigrationInterface {
  name = 'AddComplianceDocFile20260710000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "compliance_docs" ADD COLUMN IF NOT EXISTS "file_storage_key" varchar(512)`,
    );
    await queryRunner.query(
      `ALTER TABLE "compliance_docs" ADD COLUMN IF NOT EXISTS "file_name" varchar(300)`,
    );
    await queryRunner.query(
      `ALTER TABLE "compliance_docs" ADD COLUMN IF NOT EXISTS "file_mime" varchar(120)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "compliance_docs" DROP COLUMN IF EXISTS "file_mime"`,
    );
    await queryRunner.query(
      `ALTER TABLE "compliance_docs" DROP COLUMN IF EXISTS "file_name"`,
    );
    await queryRunner.query(
      `ALTER TABLE "compliance_docs" DROP COLUMN IF EXISTS "file_storage_key"`,
    );
  }
}
