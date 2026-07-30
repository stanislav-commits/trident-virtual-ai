import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-call record of model spend, so a vessel's AI cost can be reported and
 * eventually invoiced. Nothing was recorded before this table existed and the
 * numbers were computed in memory and discarded, so history cannot be
 * back-filled — every report starts at the day this ships.
 *
 * Three decisions are load-bearing for billing:
 *
 * 1. The unit prices used are stored ON the row, not looked up at read time.
 *    Provider prices change; a statement for a past month must not silently
 *    become a different number afterwards.
 *
 * 2. Cache writes are split by TTL. Anthropic bills a 5-minute cache write at
 *    1.25x input and a 1-hour write at 2x, and this codebase uses both (the
 *    catalog digest prefix is written with ttl '1h'). Collapsing them into one
 *    column is what made the existing cost log understate spend by ~37%.
 *
 * 3. `input_tokens` from Anthropic is the UNCACHED remainder only — the three
 *    input buckets are disjoint, not nested — so the total input for a call is
 *    input + cache_write_* + cache_read, and each is priced differently.
 *
 * Attribution is nullable on purpose. A background job has no user, an admin
 * has no ship by database constraint, and a call made outside any known context
 * still costs money: recording it as unattributed keeps the sum reconcilable
 * against the provider's own invoice instead of quietly dropping it.
 */
export class AddLlmUsage20260728000100 implements MigrationInterface {
  name = 'AddLlmUsage20260728000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "llm_usage" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "occurred_at" timestamptz NOT NULL DEFAULT now(),
        "ship_id" uuid,
        "user_id" uuid,
        "purpose" varchar(48) NOT NULL DEFAULT 'unattributed',
        "provider" varchar(24) NOT NULL,
        "model" varchar(64) NOT NULL,
        "status" varchar(16) NOT NULL DEFAULT 'ok',
        "input_tokens" integer NOT NULL DEFAULT 0,
        "output_tokens" integer NOT NULL DEFAULT 0,
        "cache_write_5m_tokens" integer NOT NULL DEFAULT 0,
        "cache_write_1h_tokens" integer NOT NULL DEFAULT 0,
        "cache_read_tokens" integer NOT NULL DEFAULT 0,
        "price_input_per_mtok" numeric(10,4),
        "price_output_per_mtok" numeric(10,4),
        "price_cache_write_5m_per_mtok" numeric(10,4),
        "price_cache_write_1h_per_mtok" numeric(10,4),
        "price_cache_read_per_mtok" numeric(10,4),
        "cost_usd" numeric(12,6),
        "priced" boolean NOT NULL DEFAULT false,
        "request_id" varchar(128),
        "latency_ms" integer,
        CONSTRAINT "PK_llm_usage" PRIMARY KEY ("id"),
        CONSTRAINT "FK_llm_usage_ship" FOREIGN KEY ("ship_id")
          REFERENCES "ships"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_llm_usage_user" FOREIGN KEY ("user_id")
          REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    // Every read of this table is "one vessel, one month", so the index leads
    // with the ship and carries the time.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_llm_usage_ship_time"
        ON "llm_usage" ("ship_id", "occurred_at")
    `);
    // Reconciliation against the provider invoice ignores the ship.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_llm_usage_time"
        ON "llm_usage" ("occurred_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_llm_usage_time"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_llm_usage_ship_time"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_usage"`);
  }
}
