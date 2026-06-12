import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Rebuild the assets table to match the real per-vessel Asset Register format
 * we now have for SeaWolf X (xlsx with 29 columns, 1835 rows).
 *
 * The minimal Phase 0 schema (sfi_code + name + 6 fields) was too thin —
 * real registers carry:
 *   - asset_id_internal (yard-issued unique key, e.g. SWX.3.2.1.01-PS)
 *   - sfi_group / sfi_sub / sfi_sub_name (SFI category split, not one field)
 *   - parent_asset_id / served_by_asset_id / location_asset_id (hierarchy)
 *   - criticality (1/2/3), lifecycle_status (in-service|specified|deprecated|cross-ref)
 *   - rina_ref (class society reference — RINA for Italian-built hulls)
 *
 * Physical-location tree (zone / deck_role / deck_level / space_instance /
 * asset_full_locator) is skipped for now; comes back if we wire the
 * compartment-aware UI.
 */
export class RebuildAssetsTable20260602000200
  implements MigrationInterface
{
  name = 'RebuildAssetsTable20260602000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "assets" CASCADE`);

    await queryRunner.query(`
      CREATE TABLE "assets" (
        "id"                  uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "ship_id"             uuid NOT NULL REFERENCES "ships"("id") ON DELETE CASCADE,

        "asset_id_internal"   varchar(80)  NOT NULL,
        "display_name"        varchar(255) NOT NULL,

        "sfi_group"           varchar(10),
        "sfi_sub"             varchar(20),
        "sfi_sub_name"        varchar(255),

        "parent_asset_id"     varchar(80),
        "served_by_asset_id"  varchar(80),
        "location_asset_id"   varchar(80),

        "brand"               varchar(255),
        "model"               varchar(255),
        "serial_no"           varchar(255),

        "criticality"         smallint,
        "lifecycle_status"    varchar(20) NOT NULL DEFAULT 'in-service',
        "commissioned_date"   date,
        "location"            varchar(255),
        "rina_ref"            varchar(100),
        "notes"               text,

        "created_at"          timestamptz NOT NULL DEFAULT now(),
        "updated_at"          timestamptz NOT NULL DEFAULT now(),

        CONSTRAINT "UQ_assets_ship_assetid"
          UNIQUE ("ship_id", "asset_id_internal"),
        CONSTRAINT "CHK_assets_lifecycle"
          CHECK ("lifecycle_status" IN ('in-service','specified','deprecated','cross-ref')),
        CONSTRAINT "CHK_assets_criticality"
          CHECK ("criticality" IS NULL OR "criticality" BETWEEN 1 AND 5)
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_assets_ship_id"          ON "assets" ("ship_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_assets_asset_id_internal" ON "assets" ("ship_id", "asset_id_internal")`);
    await queryRunner.query(`CREATE INDEX "IDX_assets_sfi_group"        ON "assets" ("ship_id", "sfi_group")`);
    await queryRunner.query(`CREATE INDEX "IDX_assets_sfi_sub"          ON "assets" ("ship_id", "sfi_sub")`);
    await queryRunner.query(`CREATE INDEX "IDX_assets_lifecycle"        ON "assets" ("ship_id", "lifecycle_status")`);
    await queryRunner.query(`CREATE INDEX "IDX_assets_parent"           ON "assets" ("ship_id", "parent_asset_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "assets"`);
  }
}
