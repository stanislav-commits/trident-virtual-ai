import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds documents.ai_summary — a short AI-generated descriptor for FILE lookup
 * (the `files` chat route that returns the original file). Populated cheaply at
 * upload for plans (single-page vision caption); reusable for any document type.
 */
export class AddDocumentAiSummary20260624000100 implements MigrationInterface {
  name = 'AddDocumentAiSummary20260624000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "ai_summary" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "documents" DROP COLUMN IF EXISTS "ai_summary"`,
    );
  }
}
