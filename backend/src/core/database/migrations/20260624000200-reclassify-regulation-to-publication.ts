import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Knowledge Base redesign — prod data finalisation (part 1, non-destructive).
 * The legacy `regulation` doc class is folded into `publication` (rules/regs are
 * Publications in the new model). Pure relabel — no rows deleted, RAGFlow and
 * Spaces objects keep working (only doc_class changes). The retired
 * `historical_procedure` and `certificate` docs are NOT touched here: deleting
 * them must clean RAGFlow chunks + Spaces originals too, so that is done via the
 * app's document-delete path, not raw SQL.
 *
 * No-op on environments that never had `regulation` docs (e.g. local).
 */
export class ReclassifyRegulationToPublication20260624000200
  implements MigrationInterface
{
  name = 'ReclassifyRegulationToPublication20260624000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "documents" SET "doc_class" = 'publication' WHERE "doc_class" = 'regulation'`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible: once relabelled we can no longer tell which publications
    // were originally regulations. Leaving them as publications is harmless.
  }
}
