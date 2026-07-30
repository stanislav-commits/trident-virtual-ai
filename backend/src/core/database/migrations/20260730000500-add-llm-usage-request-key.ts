import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A conflict key for imported spend.
 *
 * The manual extractor keeps its own audit log of every call it makes, and the
 * ledger now replays that file. Replaying has to be safe to repeat — after every
 * extraction run, and over the whole history when the importer changes — so a
 * row imported twice must collide instead of doubling the bill.
 *
 * Partial on purpose: calls recorded live carry the provider's request id, which
 * is unique per call but not guaranteed to be present, and two different runs
 * legitimately share a null. Only rows that carry a key are constrained.
 */
export class AddLlmUsageRequestKey20260730000500 implements MigrationInterface {
  name = 'AddLlmUsageRequestKey20260730000500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Anything imported before the index existed would block it; the importer
    // is idempotent from here on, so clearing the duplicates is safe.
    await queryRunner.query(`
      DELETE FROM "llm_usage" a
       USING "llm_usage" b
       WHERE a."request_id" IS NOT NULL
         AND a."request_id" = b."request_id"
         AND a."provider" = b."provider"
         AND a."id" > b."id"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_llm_usage_provider_request"
        ON "llm_usage" ("provider", "request_id")
        WHERE "request_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_llm_usage_provider_request"`,
    );
  }
}
