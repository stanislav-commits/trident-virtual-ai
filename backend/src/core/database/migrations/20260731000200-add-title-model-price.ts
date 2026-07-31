import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Price the model that writes chat titles.
 *
 * Titles moved off gpt-5-mini onto gpt-4.1-nano — the cheapest model on the
 * card, and the one job where model quality changes nothing. Without a row
 * here every title call would be recorded UNPRICED, which is how a line
 * quietly disappears from the bill.
 */
export class AddTitleModelPrice20260731000200 implements MigrationInterface {
  name = 'AddTitleModelPrice20260731000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "llm_model_prices"
        ("model_prefix", "input_per_mtok", "output_per_mtok", "note")
      VALUES ('gpt-4.1-nano', 0.1000, 0.4000, 'Chat titles only')
      ON CONFLICT ("model_prefix") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "llm_model_prices" WHERE "model_prefix" = 'gpt-4.1-nano'`,
    );
  }
}
