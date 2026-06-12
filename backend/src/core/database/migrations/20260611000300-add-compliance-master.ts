import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vessel-agnostic compliance master: the FULL Cert_Applicability_Matrix
 * from the SFI Master (one row per doc type, applicability per GT bucket /
 * operation / flag), so that per-ship rulebooks (compliance_doc_types)
 * can be GENERATED for every new yacht from its profile instead of being
 * hand-seeded. Ships gain the three profile fields the resolution needs.
 */
export class AddComplianceMaster20260611000300 implements MigrationInterface {
  name = 'AddComplianceMaster20260611000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "compliance_doc_master" (
        "id"             uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sfi_code"       varchar(20) NOT NULL UNIQUE,
        "section_code"   varchar(10) NOT NULL,
        "section_name"   varchar(120) NOT NULL,
        "name"           varchar(255) NOT NULL,
        "scope"          varchar(20) NOT NULL,
        "linked_sfi"     varchar(60),
        "app_lt24"       varchar(2) NOT NULL DEFAULT '',
        "app_24_300"     varchar(2) NOT NULL DEFAULT '',
        "app_300_399"    varchar(2) NOT NULL DEFAULT '',
        "app_400_499"    varchar(2) NOT NULL DEFAULT '',
        "app_500_3000"   varchar(2) NOT NULL DEFAULT '',
        "app_gt3000"     varchar(2) NOT NULL DEFAULT '',
        "app_private"    varchar(2) NOT NULL DEFAULT '',
        "app_commercial" varchar(2) NOT NULL DEFAULT '',
        "app_yet"        varchar(2) NOT NULL DEFAULT '',
        "app_red_ensign" varchar(2) NOT NULL DEFAULT '',
        "app_eu_flag"    varchar(2) NOT NULL DEFAULT '',
        "app_other_flag" varchar(2) NOT NULL DEFAULT '',
        "renewal_cycle"  varchar(120),
        "survey_window"  varchar(160),
        "update_trigger" varchar(200),
        "notes"          text,
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_compliance_doc_master" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "ships"
      ADD COLUMN "gt_bucket" varchar(20),
      ADD COLUMN "operation_type" varchar(20),
      ADD COLUMN "flag_registry" varchar(30)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ships"
      DROP COLUMN "gt_bucket",
      DROP COLUMN "operation_type",
      DROP COLUMN "flag_registry"
    `);
    await queryRunner.query(`DROP TABLE "compliance_doc_master"`);
  }
}
