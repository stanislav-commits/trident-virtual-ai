import { MigrationInterface, QueryRunner } from 'typeorm';

export class UseDecimalDocumentParseProgress20260428000200
  implements MigrationInterface
{
  name = 'UseDecimalDocumentParseProgress20260428000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
      ALTER COLUMN "parse_progress_percent"
      TYPE numeric(6, 2)
      USING "parse_progress_percent"::numeric(6, 2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "documents"
      ALTER COLUMN "parse_progress_percent"
      TYPE integer
      USING ROUND("parse_progress_percent")::integer
    `);
  }
}
