import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Knowledge Base redesign (Phase 1a): add the new document classes
 * (procedure / form / plan / publication). The legacy classes
 * (historical_procedure, certificate, regulation) stay for now; their data is
 * reclassified/removed and chat-retrieval branches are cleaned up in Phase 1b.
 * Postgres can't USE a freshly-added enum value in the same transaction, so the
 * `regulation → publication` data reclassify is a separate later migration.
 */
export class AddKnowledgeBaseDocClasses20260623000100
  implements MigrationInterface
{
  name = 'AddKnowledgeBaseDocClasses20260623000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of ['procedure', 'form', 'plan', 'publication']) {
      await queryRunner.query(
        `ALTER TYPE "public"."document_doc_class_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres can't drop a single enum value without rebuilding the type;
    // leaving the added values in place is harmless.
  }
}
