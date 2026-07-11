import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * lifecycle_status is retired: every asset in the fleet register carries the
 * same 'in-service' value (verified on prod — 1476/1476), the UI never edits
 * it and all code filters on it were no-ops. Removed end-to-end (entity,
 * DTOs, xlsx import/export, AI tool filters, UI badge) — this drops the
 * column and its index.
 */
export class DropAssetLifecycleStatus20260711000300 implements MigrationInterface {
  name = 'DropAssetLifecycleStatus20260711000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assets_lifecycle"`);
    await queryRunner.query(
      `ALTER TABLE "assets" DROP COLUMN IF EXISTS "lifecycle_status"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "lifecycle_status" varchar(20) NOT NULL DEFAULT 'in-service'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_assets_lifecycle" ON "assets" ("ship_id", "lifecycle_status")`,
    );
  }
}
