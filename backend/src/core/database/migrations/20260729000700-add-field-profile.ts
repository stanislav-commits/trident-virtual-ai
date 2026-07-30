import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-document field visibility, from the certificate field matrix.
 *
 * The legend leaves no room for interpretation: "☑ = field is displayed and
 * populated from document scan; ☐ = field is hidden for this document type. No
 * optional values." And the profile is NOT a function of the document type —
 * 32 STAT_CERT rows produce 16 different signatures, 55 across the 117 rows the
 * matrix covers — so it has to live on the catalogue row, not on the type.
 *
 * `field_profile` is the ordered list of visible field slugs, taken from the 22
 * tick columns. Nine of them (vessel_gt, vessel_nt, vessel_imo, official_number,
 * vessel_call_sign, vessel_flag, port_of_registry, registered_owner,
 * principal_dimensions) are not stored per record at all — 1.1.1's template says
 * they "should auto-populate from Vessel Master Data", so the profile is a
 * display mask over the columns added to `ships`.
 *
 * `special_data` keeps the matrix's Special Certificate Data cell verbatim. It
 * has 114 distinct values across 117 rows and a few of them are prose rather
 * than field names, so it is shown to the operator rather than parsed.
 */
export class AddFieldProfile20260729000700 implements MigrationInterface {
  name = 'AddFieldProfile20260729000700';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['compliance_doc_master', 'compliance_doc_types']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN IF NOT EXISTS "field_profile" jsonb,
          ADD COLUMN IF NOT EXISTS "special_data" text
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['compliance_doc_master', 'compliance_doc_types']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN IF EXISTS "field_profile",
          DROP COLUMN IF EXISTS "special_data"
      `);
    }
  }
}
