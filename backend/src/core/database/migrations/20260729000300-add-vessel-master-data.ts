import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vessel master data — the identity fields auto-populated into certificates.
 *
 * The certificate field matrix ticks nine vessel-identity columns across the
 * catalogue (Vessel GT, NT, IMO, Official Number, Call Sign, Flag, Port of
 * Registry, Registered Owner, Principal Dimensions); they come from Vessel
 * Master Data rather than being typed onto each certificate. Five of the nine already exist on `ships`; these are
 * the rest.
 *
 * `port_of_registry` is deliberately NOT `home_port`: the port a vessel is
 * registered in is a legal fact printed on the Certificate of Registry, while
 * home_port is operational and can differ.
 *
 * `company_name` / `company_imo_number` are the ISM Company, not the owner —
 * the Document of Compliance and the ISM Code 3.1 declaration are issued to it,
 * and 1.7.3's key metadata lists "Company IMO number" explicitly.
 */
export class AddVesselMasterData20260729000300 implements MigrationInterface {
  name = 'AddVesselMasterData20260729000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ships"
        ADD COLUMN IF NOT EXISTS "net_tonnage" integer,
        ADD COLUMN IF NOT EXISTS "official_number" varchar(40),
        ADD COLUMN IF NOT EXISTS "port_of_registry" varchar(120),
        ADD COLUMN IF NOT EXISTS "registered_owner" varchar(200),
        ADD COLUMN IF NOT EXISTS "company_name" varchar(200),
        ADD COLUMN IF NOT EXISTS "company_imo_number" varchar(10),
        ADD COLUMN IF NOT EXISTS "beam_m" numeric(6,2),
        ADD COLUMN IF NOT EXISTS "depth_m" numeric(6,2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ships"
        DROP COLUMN IF EXISTS "net_tonnage",
        DROP COLUMN IF EXISTS "official_number",
        DROP COLUMN IF EXISTS "port_of_registry",
        DROP COLUMN IF EXISTS "registered_owner",
        DROP COLUMN IF EXISTS "company_name",
        DROP COLUMN IF EXISTS "company_imo_number",
        DROP COLUMN IF EXISTS "beam_m",
        DROP COLUMN IF EXISTS "depth_m"
    `);
  }
}
