import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Price the model the admin panel's background work runs on.
 *
 * Metric labelling, catalogue clustering, certificate extraction and alarm
 * analysis moved from the OpenAI sub-model onto claude-haiku-4-5. Unpriced
 * models are left unpriced on purpose — an unknown model on an invoice must be
 * visible — so without this row every one of those calls would drop off the
 * bill instead of showing up cheap.
 */
export class AddAdminModelPrice20260731000300 implements MigrationInterface {
  name = 'AddAdminModelPrice20260731000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "llm_model_prices"
        ("model_prefix", "input_per_mtok", "output_per_mtok", "note")
      VALUES ('claude-haiku-4-5', 1.0000, 5.0000, 'Admin panel background work')
      ON CONFLICT ("model_prefix") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "llm_model_prices" WHERE "model_prefix" = 'claude-haiku-4-5'`,
    );
  }
}
