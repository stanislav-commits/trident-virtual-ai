import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The rate card, out of the code and into a table.
 *
 * Rates changed with a deploy, which meant a price rise sat unrecorded until
 * someone shipped — and the ledger quietly kept billing at the old number.
 * The table is edited from the admin panel and takes effect on the next call.
 *
 * Seeded with the rates the compiled book carried when this was written, so
 * nothing about pricing changes as it lands: same prefixes, same numbers. They
 * are spelled out here rather than imported from the module — a migration has
 * to keep doing what it did when it ran, and the module's list is now just a
 * cold-start fallback that will drift as rates are edited in the panel.
 *
 * Only the two published rates are stored; the cache rates stay derived from
 * the input rate by fixed multipliers.
 */
export class AddLlmModelPrices20260730000400 implements MigrationInterface {
  name = 'AddLlmModelPrices20260730000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "llm_model_prices" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "model_prefix" varchar(64) NOT NULL UNIQUE,
        "input_per_mtok" numeric(10,4) NOT NULL,
        "output_per_mtok" numeric(10,4) NOT NULL,
        "note" varchar(200),
        "updated_by_user_id" uuid,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);

    // The models this platform actually calls. A model not listed here is
    // recorded WITHOUT a cost and counted as unpriced on the usage card, which
    // is the point: an unknown model on an invoice has to be visible, not
    // quietly charged at whatever a neighbouring family costs.
    const seed: Array<[prefix: string, input: number, output: number]> = [
      ['claude-sonnet-4', 3, 15], // chat answers, vision, metrics, compliance
      ['gpt-5-mini', 0.25, 2], //    titles, classifier, decomposer
      ['gpt-4.1-mini', 0.15, 0.6], // bulk metric analysis
      ['gpt-4o', 2.5, 10], //        manual extraction, per page
      ['gpt-4o-mini', 0.15, 0.6], //  manual classification
      // Embeddings bill on input only; the output rate is zero, not missing.
      ['text-embedding-3-small', 0.02, 0],
    ];

    for (const [prefix, input, output] of seed) {
      await queryRunner.query(
        `INSERT INTO "llm_model_prices"
           ("model_prefix", "input_per_mtok", "output_per_mtok", "note")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("model_prefix") DO NOTHING`,
        [prefix, input, output, 'Seeded from the published rates, 30 Jul 2026'],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "llm_model_prices"`);
  }
}
