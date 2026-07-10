import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * First-class columns for two fields the final SeaWolf X register (14-col
 * format) carries: `sfi_group_name` (group label) and `drawing_code` (source
 * drawing element id, a stable per-item key). Previously these were dropped on
 * import (not in the field map); now they persist and round-trip.
 */
export class AddAssetDrawingCodeGroupName20260709000100
  implements MigrationInterface
{
  name = 'AddAssetDrawingCodeGroupName20260709000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "sfi_group_name" varchar(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "drawing_code" varchar(80)`,
    );
    // Backfill from the extras bucket where an earlier import parked them, then
    // drop those keys from extras so they live only as first-class columns.
    await queryRunner.query(
      `UPDATE "assets" SET "drawing_code" = "extras"->>'drawing_code'
       WHERE "drawing_code" IS NULL AND "extras" ? 'drawing_code'`,
    );
    await queryRunner.query(
      `UPDATE "assets" SET "sfi_group_name" = "extras"->>'sfi_group_name'
       WHERE "sfi_group_name" IS NULL AND "extras" ? 'sfi_group_name'`,
    );
    await queryRunner.query(
      `UPDATE "assets" SET "extras" = "extras" - 'drawing_code' - 'sfi_group_name'
       WHERE "extras" ?| array['drawing_code','sfi_group_name']`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assets" DROP COLUMN IF EXISTS "drawing_code"`,
    );
    await queryRunner.query(
      `ALTER TABLE "assets" DROP COLUMN IF EXISTS "sfi_group_name"`,
    );
  }
}
