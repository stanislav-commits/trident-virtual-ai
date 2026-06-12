import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Asset table snapshot store. Before every destructive import we dump the
 * full current asset rows for the ship as one JSONB blob, so a botched
 * import (wrong file, accidental orphan-delete, brand-overwrite tantrum)
 * can be rolled back to the previous good state without restoring the
 * whole DB.
 *
 * Storing as a single JSONB row (not row-per-asset) trades query-ability
 * for write speed — snapshots are write-once, restore is rare, and
 * 1900 rows × 30 cols ≈ ~1 MB compresses well in TOAST.
 */
export class AddAssetSnapshots20260610000100 implements MigrationInterface {
  name = 'AddAssetSnapshots20260610000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "asset_snapshots" (
        "id"            uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ship_id"       uuid NOT NULL REFERENCES "ships"("id") ON DELETE CASCADE,
        "snapshot_at"   timestamptz NOT NULL DEFAULT now(),
        "reason"        varchar(80) NOT NULL,
        "asset_count"   integer NOT NULL,
        "created_by_user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
        "payload"       jsonb NOT NULL,
        PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_asset_snapshots_ship_at" ON "asset_snapshots" ("ship_id", "snapshot_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_asset_snapshots_ship_at"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "asset_snapshots"`);
  }
}
