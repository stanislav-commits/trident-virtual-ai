import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persist the full AI-transcribed text of a compliance document on the record,
 * so the chat compliance responder can answer full-text questions about short
 * documents (certificates) without RAGFlow chunking.
 */
export class AddComplianceDocExtractedText20260710000400
  implements MigrationInterface
{
  name = 'AddComplianceDocExtractedText20260710000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "compliance_docs" ADD COLUMN IF NOT EXISTS "extracted_text" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "compliance_docs" DROP COLUMN IF EXISTS "extracted_text"`,
    );
  }
}
