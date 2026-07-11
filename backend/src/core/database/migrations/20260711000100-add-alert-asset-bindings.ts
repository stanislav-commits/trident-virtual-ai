import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Interim alertname→asset mapping (see AlertAssetBindingEntity). The hand-made
 * Grafana rules carry no metric_key/asset_id labels, so alerts arrive with
 * asset_id NULL ("unbound" in the UI). This creates the mapping table, seeds
 * it with the unambiguous matches between the SeaWolfX PLC alarm names and the
 * asset register, and backfills already-ingested alerts.
 *
 * Deliberately NOT seeded (ambiguous — PLC tank numbering diverges from the
 * register): "Clean Oil Tank 19P" (register has Clean Oil 15P/18S, Sludge 19P),
 * "Urea Tank 31P" (register has Urea 26S/27P), "Warning Low Total Fuel"
 * (vessel-level, no single asset).
 */
export class AddAlertAssetBindings20260711000100 implements MigrationInterface {
  name = 'AddAlertAssetBindings20260711000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "alert_asset_bindings" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ship_id" uuid NOT NULL,
        "rule_name" varchar(255) NOT NULL,
        "asset_id" uuid NOT NULL,
        "note" varchar(255),
        "created_at" timestamp NOT NULL DEFAULT now(),
        "updated_at" timestamp NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_alert_asset_bindings_ship_rule" ON "alert_asset_bindings" ("ship_id", "rule_name")`,
    );

    // Seed: exact Grafana rule names → register assets, resolved via
    // asset_id_internal (ship-prefixed, so the join pins the ship too).
    // INSERT..SELECT is a no-op on databases without these assets (local dev).
    const seed: Array<[string, string, string]> = [
      // [rule_name, asset_id_internal, note]
      ['Fuel Tank 6S - High Level (Above 95%)', 'SWX.1.8.07', 'PLC 6S = Fuel Oil Tank 06 — Stbd'],
      ['Fuel Tank 8S - High Level (Above 95%)', 'SWX.1.8.09', 'PLC 8S = Fuel Oil Daily Tank 08 — Stbd'],
      ['Bilge Water Tank 21P - Low Level (Below 10%)', 'SWX.1.8.22', 'PLC 21P = Bilge Tank 21 — Port'],
      ['Bilge Water Tank 24S - Low Level (Below 10%)', 'SWX.1.8.25', 'PLC 24S = Bilge Tank 24 — Stbd'],
      ['Scupper Tank 29 PS - Low Level (Below 10%) (copy)', 'SWX.1.8.30', 'PLC 29 PS = Scupper Tank 29 — Port'],
      ['PS DG DEF Consumption HIGH', 'SWX.2.3.01', 'PS DG = Diesel Generator (Variable Speed) — Port'],
      ['PS DG DEF Consumption CRITICAL HIGH', 'SWX.2.3.01', 'PS DG = Diesel Generator (Variable Speed) — Port'],
      ['PS DG ECU CPU Temperature HIGH', 'SWX.2.3.01', 'PS DG = Diesel Generator (Variable Speed) — Port'],
      ['PS DG ECU CPU Temperature CRITICAL HIGH', 'SWX.2.3.01', 'PS DG = Diesel Generator (Variable Speed) — Port'],
      ['PS DG Stopped', 'SWX.2.3.01', 'PS DG = Diesel Generator (Variable Speed) — Port'],
      ['SB DG DEF Consumption HIGH', 'SWX.2.3.02', 'SB DG = Diesel Generator (Variable Speed) — Stbd'],
      ['SB DG DEF Consumption CRITICAL HIGH', 'SWX.2.3.02', 'SB DG = Diesel Generator (Variable Speed) — Stbd'],
      ['SB DG ECU CPU Temperature HIGH', 'SWX.2.3.02', 'SB DG = Diesel Generator (Variable Speed) — Stbd'],
      ['SB DG ECU CPU Temperature CRITICAL HIGH', 'SWX.2.3.02', 'SB DG = Diesel Generator (Variable Speed) — Stbd'],
      ['SB DG Stopped', 'SWX.2.3.02', 'SB DG = Diesel Generator (Variable Speed) — Stbd'],
      ['PS Propulsion STOPPED', 'SWX.2.2.01', 'Propulsion Electric Motor — Port'],
      ['SB Propulsion STOPPED', 'SWX.2.2.02', 'Propulsion Electric Motor — Stbd'],
    ];

    const skipped: string[] = [];
    for (const [ruleName, internalId, note] of seed) {
      const inserted: unknown[] = await queryRunner.query(
        `INSERT INTO "alert_asset_bindings" ("ship_id", "rule_name", "asset_id", "note")
         SELECT a."ship_id", $1, a."id", $2
         FROM "assets" a
         WHERE a."asset_id_internal" = $3
         ON CONFLICT ("ship_id", "rule_name") DO NOTHING
         RETURNING "id"`,
        [ruleName, note, internalId],
      );
      if (inserted.length === 0) {
        skipped.push(`${ruleName} -> ${internalId}`);
      }
    }
    if (skipped.length > 0) {
      // Expected on databases without the SeaWolfX register (local dev);
      // on prod a non-empty list means a typo'd asset_id_internal.
      console.warn(
        `[AddAlertAssetBindings] ${skipped.length}/${seed.length} seed rows matched no asset:\n  ${skipped.join('\n  ')}`,
      );
    }

    // Backfill already-ingested unbound alerts from the new bindings.
    await queryRunner.query(`
      UPDATE "alerts" al
      SET "asset_id" = b."asset_id"
      FROM "alert_asset_bindings" b
      WHERE al."asset_id" IS NULL
        AND al."ship_id" = b."ship_id"
        AND al."rule_name" = b."rule_name"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "alert_asset_bindings"`);
  }
}
