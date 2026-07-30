import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A single photo per vessel, for the Overview page.
 *
 * The binary lives in object storage (or the local spool) and only its metadata
 * lands here: the provider used at upload time, so a read still works after the
 * storage switch is flipped, and the content type, so the download endpoint does
 * not have to guess. No key column — there is exactly one object per vessel and
 * its key is derived from the ship id.
 */
export class AddShipPhoto20260729000100 implements MigrationInterface {
  name = 'AddShipPhoto20260729000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ships"
        ADD COLUMN IF NOT EXISTS "photo_provider" varchar(16),
        ADD COLUMN IF NOT EXISTS "photo_mime" varchar(64),
        ADD COLUMN IF NOT EXISTS "photo_updated_at" timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ships"
        DROP COLUMN IF EXISTS "photo_provider",
        DROP COLUMN IF EXISTS "photo_mime",
        DROP COLUMN IF EXISTS "photo_updated_at"
    `);
  }
}
