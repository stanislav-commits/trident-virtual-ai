import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Spend that is not measured in tokens.
 *
 * Voice transcription bills by the minute of audio, so a token ledger had
 * nowhere to put it and the crew's voice notes cost nothing on paper. The usage
 * row gains the clip's length and the rate card gains a per-minute price, left
 * null for every model that bills on tokens.
 *
 * whisper-1 is seeded at its published rate. Like every other rate it is
 * editable from the panel afterwards.
 */
export class AddAudioUsage20260730000600 implements MigrationInterface {
  name = 'AddAudioUsage20260730000600';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "llm_usage"
        ADD COLUMN IF NOT EXISTS "audio_seconds" integer NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "llm_model_prices"
        ADD COLUMN IF NOT EXISTS "per_minute_usd" numeric(10,5)
    `);
    // Token rates are zero rather than null: this model has none, which is a
    // fact about how it bills, not a gap in what we know.
    await queryRunner.query(`
      INSERT INTO "llm_model_prices"
        ("model_prefix", "input_per_mtok", "output_per_mtok", "per_minute_usd", "note")
      VALUES ('whisper', 0, 0, 0.006, 'Billed per minute of audio')
      ON CONFLICT ("model_prefix") DO NOTHING
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "llm_model_prices" WHERE "model_prefix" = 'whisper'`,
    );
    await queryRunner.query(
      `ALTER TABLE "llm_model_prices" DROP COLUMN IF EXISTS "per_minute_usd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "llm_usage" DROP COLUMN IF EXISTS "audio_seconds"`,
    );
  }
}
