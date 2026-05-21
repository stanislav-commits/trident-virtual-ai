import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDocumentBusinessMetadata20260521000100
  implements MigrationInterface
{
  name = 'AddDocumentBusinessMetadata20260521000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD COLUMN "equipment_name" character varying(255),
      ADD COLUMN "equipment_aliases" text,
      ADD COLUMN "system_area" character varying(255),
      ADD COLUMN "document_purpose" text,
      ADD COLUMN "document_role" character varying(64)
    `);

    await queryRunner.query(`
      ALTER TABLE "documents"
      ADD CONSTRAINT "CHK_documents_document_role"
      CHECK (
        "document_role" IS NULL OR
        "document_role" IN (
          'manual',
          'equipment_register',
          'asset_register',
          'pms_record',
          'specification',
          'certificate',
          'regulation',
          'other'
        )
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
      DROP CONSTRAINT IF EXISTS "CHK_documents_document_role"
    `);

    await queryRunner.query(`
      ALTER TABLE "documents"
      DROP COLUMN IF EXISTS "document_role",
      DROP COLUMN IF EXISTS "document_purpose",
      DROP COLUMN IF EXISTS "system_area",
      DROP COLUMN IF EXISTS "equipment_aliases",
      DROP COLUMN IF EXISTS "equipment_name"
    `);
  }
}
