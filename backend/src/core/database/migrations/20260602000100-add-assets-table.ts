import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 0 of the metric-understanding rebuild: introduce a real `assets`
 * registry per ship. Every metric will eventually be FK-bound to an asset
 * (Phase 1), the AI bootstrap (Phase 2) reads the asset list to pick the
 * correct bound_asset_id, and the V3 admin UI Asset Register reads/writes
 * here.
 *
 * SFI codes are unique inside a ship but the same code (e.g. "02.1.001"
 * for "port main engine") appears on every ship, so the natural unique
 * key is (ship_id, sfi_code).
 */
export class AddAssetsTable20260602000100 implements MigrationInterface {
  name = 'AddAssetsTable20260602000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "assets" (
        "id"            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "ship_id"       uuid NOT NULL REFERENCES "ships"("id") ON DELETE CASCADE,
        "sfi_code"      varchar(20)  NOT NULL,
        "name"          varchar(255) NOT NULL,
        "manufacturer"  varchar(255),
        "model"         varchar(255),
        "serial_no"     varchar(255),
        "location"      varchar(255),
        "install_date"  date,
        "class_society" varchar(100),
        "status"        varchar(32) NOT NULL DEFAULT 'operational',
        "notes"         text,
        "created_at"    timestamptz NOT NULL DEFAULT now(),
        "updated_at"    timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_assets_ship_sfi" UNIQUE ("ship_id", "sfi_code"),
        CONSTRAINT "CHK_assets_status"
          CHECK ("status" IN ('operational','maintenance','fault','retired'))
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_assets_ship_id"   ON "assets" ("ship_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_assets_sfi_code"  ON "assets" ("ship_id", "sfi_code")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_assets_status"    ON "assets" ("ship_id", "status")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "assets"`);
  }
}
