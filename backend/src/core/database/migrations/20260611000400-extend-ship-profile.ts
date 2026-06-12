import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Full vessel profile for the "Add vessel workspace" flow (V2 mock):
 * identity (MMSI, call sign, flag), build facts (length, shipyard, class
 * society, home port), contact, and EXACT gross tonnage. The compliance
 * GT bucket is derived from gross_tonnage + length_m at rulebook
 * generation time — gt_bucket stays as a manual override/fallback.
 */
export class ExtendShipProfile20260611000400 implements MigrationInterface {
  name = 'ExtendShipProfile20260611000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ships"
      ADD COLUMN "mmsi"                varchar(20),
      ADD COLUMN "call_sign"           varchar(20),
      ADD COLUMN "flag"                varchar(80),
      ADD COLUMN "length_m"            numeric(6,2),
      ADD COLUMN "gross_tonnage"       integer,
      ADD COLUMN "shipyard"            varchar(120),
      ADD COLUMN "class_society"       varchar(120),
      ADD COLUMN "home_port"           varchar(120),
      ADD COLUMN "fleet_manager_email" varchar(160)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ships"
      DROP COLUMN "mmsi",
      DROP COLUMN "call_sign",
      DROP COLUMN "flag",
      DROP COLUMN "length_m",
      DROP COLUMN "gross_tonnage",
      DROP COLUMN "shipyard",
      DROP COLUMN "class_society",
      DROP COLUMN "home_port",
      DROP COLUMN "fleet_manager_email"
    `);
  }
}
