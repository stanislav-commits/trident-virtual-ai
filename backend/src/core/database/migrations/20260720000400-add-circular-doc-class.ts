import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Knowledge Base: new `circular` document class — fleet circulars / notices
 * issued by the vessel's management company (JMS "Fleet Circular NN YYYY").
 * They carry standing instructions and required actions, so they are a
 * retrievable KB section alongside procedures and forms.
 */
export class AddCircularDocClass20260720000400 implements MigrationInterface {
  name = 'AddCircularDocClass20260720000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."document_doc_class_enum" ADD VALUE IF NOT EXISTS 'circular'`,
    );
  }

  public async down(): Promise<void> {
    // Postgres can't drop a single enum value without rebuilding the type;
    // leaving the added value in place is harmless.
  }
}
