import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDocumentParseProgress20260428000100
  implements MigrationInterface
{
  name = 'AddDocumentParseProgress20260428000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD COLUMN IF NOT EXISTS "parse_progress_percent" integer
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'CHK_documents_parse_progress_percent'
        ) THEN
          ALTER TABLE "documents"
          ADD CONSTRAINT "CHK_documents_parse_progress_percent"
          CHECK (
            "parse_progress_percent" IS NULL
            OR (
              "parse_progress_percent" >= 0
              AND "parse_progress_percent" <= 100
            )
          );
        END IF;
      END
      $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
      DROP CONSTRAINT IF EXISTS "CHK_documents_parse_progress_percent"
    `);

    await queryRunner.query(`
      ALTER TABLE "documents"
      DROP COLUMN IF EXISTS "parse_progress_percent"
    `);
  }
}
