import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which department owns a piece of equipment.
 *
 * A defect reported from chat carries whatever department the reporter's
 * position implies, so the same broken pump lands with deck or with engine
 * depending on who walked past it. The equipment's own department is the fact
 * that does not move, and the register is where it belongs.
 *
 * Backfilled from the SFI group, which is already the vessel's own systems map.
 * The assignments below are the defensible reading of that map; three are
 * judgement calls rather than facts, and each row is overridable per asset:
 *   - Fire, Safety & Security → deck. LSA and portable FFE are deck-maintained
 *     on a yacht this size; the fixed CO2/water-mist plant sits in the same SFI
 *     group and is engine work, so those rows will need correcting by hand.
 *   - Navigation, Bridge & Comms → deck. There is no 'bridge' department in the
 *     position model (see departmentForPosition) and watchkeepers are deck.
 *   - AV, IT & Automation → engine. Automation and networking are ETO work;
 *     guest-facing AV is arguably interior.
 * Hull & Structure covers hatches, doors and anodes — deck. HVAC, water,
 * electrical, machinery and propulsion are engine. Galley/laundry is galley.
 */
export class AddAssetDepartment20260731000100 implements MigrationInterface {
  name = 'AddAssetDepartment20260731000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "assets"
        ADD COLUMN IF NOT EXISTS "department" varchar(16)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_assets_department"
        ON "assets" ("ship_id", "department")
    `);

    // Keyed on the SFI group CODE, not its printed name: the code is the part
    // of the register id (SWX.<group>.<sub>.<seq>) and is present on every row,
    // while the name is a label that some imports leave empty.
    const byGroup: Array<[group: string, department: string]> = [
      ['1', 'deck'], //   Hull & Structure
      ['2', 'engine'], // Propulsion & Power Generation
      ['3', 'engine'], // Machinery Systems
      ['4', 'engine'], // Electrical Systems
      ['5', 'engine'], // HVAC & Refrigeration
      ['6', 'engine'], // Water Systems
      ['7', 'deck'], //   Fire, Safety & Security
      ['8', 'deck'], //   Navigation, Bridge & Comms
      ['9', 'engine'], // AV, IT & Automation
      ['10', 'deck'], //  Deck Equipment & Lifting
      ['11', 'deck'], //  Tenders, Toys & Recreational Craft
      ['12', 'galley'], //Galley, Laundry & Hospitality
      ['17', 'deck'], //  Deck — Inventory, Equip & Consumables
    ];

    for (const [group, department] of byGroup) {
      await queryRunner.query(
        `UPDATE "assets" SET "department" = $2
          WHERE "department" IS NULL
            AND (
              "sfi_group" = $1
              OR split_part("asset_id_internal", '.', 2) = $1
            )`,
        [group, department],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_assets_department"`);
    await queryRunner.query(
      `ALTER TABLE "assets" DROP COLUMN IF EXISTS "department"`,
    );
  }
}
