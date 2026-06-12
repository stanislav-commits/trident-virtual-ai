import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extend the `assets` table with v14.6 canonical location, maintenance,
 * and provenance fields. Source of truth is the SFI Master v14.6
 * Asset_Register sheet (vessel-agnostic schema):
 *
 *   - zone, deck_role, deck_level, space_instance, space_label
 *       → universal location schema (15 zone codes × 16 deck-role codes ×
 *         vessel-local space instances). Enables fleet-wide spatial chat
 *         queries like "what's in zone M / on the bridge / underwater hull".
 *
 *   - drawing_ref, inspection_obligation
 *       → high fill-rate (80% / 57% in the SeaWolfX v6.20 file). Unlocks
 *         drawing lookups + inspection schedule answers in chat.
 *
 *   - parent_auto_populated, criticality_auto_populated
 *       → provenance flags. TRUE means the value was inferred by an
 *         automated rule and still needs human review.
 *
 *   - source_sheet
 *       → which xlsx tab this row came from during import. Useful for
 *         audit + debugging the importer.
 *
 *   - extras (JSONB)
 *       → bucket for vessel-specific or rarely-populated fields that
 *         aren't part of v14.6 canonical schema yet:
 *         asset_voltage_class, served_by_emergency, governing_certs,
 *         linked_to_asset_id, id_source, required_minimum_quantity,
 *         batch_number, etc. Storing as JSONB avoids future migrations
 *         per-field while keeping the data discoverable.
 *
 * Indexes added only where chat queries will filter — zone & deck_role
 * are the two columns chat will partition on most.
 */
export class AddAssetV14LocationFields20260609000200
  implements MigrationInterface
{
  name = 'AddAssetV14LocationFields20260609000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assets"
        ADD COLUMN "zone"                       varchar(2)   NULL,
        ADD COLUMN "deck_role"                  varchar(10)  NULL,
        ADD COLUMN "deck_level"                 smallint     NULL,
        ADD COLUMN "space_instance"             varchar(50)  NULL,
        ADD COLUMN "space_label"                varchar(255) NULL,
        ADD COLUMN "drawing_ref"                varchar(255) NULL,
        ADD COLUMN "inspection_obligation"      text         NULL,
        ADD COLUMN "parent_auto_populated"      boolean      NULL,
        ADD COLUMN "criticality_auto_populated" boolean      NULL,
        ADD COLUMN "source_sheet"               varchar(100) NULL,
        ADD COLUMN "extras"                     jsonb        NULL
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_assets_zone" ON "assets" ("ship_id", "zone")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_assets_deck_role" ON "assets" ("ship_id", "deck_role")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_assets_deck_role"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_assets_zone"`);
    await queryRunner.query(`
      ALTER TABLE "assets"
        DROP COLUMN IF EXISTS "extras",
        DROP COLUMN IF EXISTS "source_sheet",
        DROP COLUMN IF EXISTS "criticality_auto_populated",
        DROP COLUMN IF EXISTS "parent_auto_populated",
        DROP COLUMN IF EXISTS "inspection_obligation",
        DROP COLUMN IF EXISTS "drawing_ref",
        DROP COLUMN IF EXISTS "space_label",
        DROP COLUMN IF EXISTS "space_instance",
        DROP COLUMN IF EXISTS "deck_level",
        DROP COLUMN IF EXISTS "deck_role",
        DROP COLUMN IF EXISTS "zone"
    `);
  }
}
