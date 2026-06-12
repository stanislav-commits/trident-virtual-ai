import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Compliance Docs module (Shaun's "certificates in the asset register",
 * 2026-06-11): a per-ship rulebook of document types (SFI group 1
 * numbering from the SFI Master v14.6 Cert_Applicability_Matrix) plus the
 * concrete records the vessel holds. Status (MISSING / EXPIRED / EXPIRING
 * / VALID) is derived at read time; gap analysis = required types with no
 * valid records.
 */
export class AddComplianceDocs20260611000200 implements MigrationInterface {
  name = 'AddComplianceDocs20260611000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "compliance_doc_types" (
        "id"             uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ship_id"        uuid NOT NULL REFERENCES "ships"("id") ON DELETE CASCADE,
        "sfi_code"       varchar(20) NOT NULL,
        "section_code"   varchar(10) NOT NULL,
        "section_name"   varchar(120) NOT NULL,
        "name"           varchar(255) NOT NULL,
        "scope"          varchar(20) NOT NULL,
        "linked_sfi"     varchar(60),
        "applicability"  varchar(2) NOT NULL,
        "renewal_cycle"  varchar(120),
        "survey_window"  varchar(160),
        "update_trigger" varchar(200),
        "notes"          text,
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_compliance_doc_types" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_compliance_doc_types_ship_sfi"
      ON "compliance_doc_types" ("ship_id", "sfi_code")
    `);

    await queryRunner.query(`
      CREATE TABLE "compliance_docs" (
        "id"           uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ship_id"      uuid NOT NULL REFERENCES "ships"("id") ON DELETE CASCADE,
        "doc_type_id"  uuid NOT NULL REFERENCES "compliance_doc_types"("id") ON DELETE CASCADE,
        "cert_no"      varchar(120),
        "issuer"       varchar(160),
        "issue_date"   date,
        "expiry_date"  date,
        "asset_id"     uuid REFERENCES "assets"("id") ON DELETE SET NULL,
        "document_id"  uuid REFERENCES "documents"("id") ON DELETE SET NULL,
        "notes"        text,
        "created_at"   timestamptz NOT NULL DEFAULT now(),
        "updated_at"   timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_compliance_docs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_compliance_docs_ship" ON "compliance_docs" ("ship_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_compliance_docs_type" ON "compliance_docs" ("doc_type_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_compliance_docs_asset" ON "compliance_docs" ("asset_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "compliance_docs"`);
    await queryRunner.query(`DROP TABLE "compliance_doc_types"`);
  }
}
