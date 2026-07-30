import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The v60 Review Notes decisions for section 1.11 (Insurance).
 *
 * 1.11.3 — "Merge the separate Greece, Italy and Spain records into one
 * multi-document entry… Replace 1.11.3–1.11.5 with 1.11.3 P&I Regional
 * Supplements and tag each attachment by jurisdiction." Reason given: "separate
 * document types do not scale."
 *
 * The jurisdiction is preserved on each moved record as `fields.jurisdiction`
 * — the tag has to survive the merge or the merge destroys the only thing that
 * told the three apart. Production holds 2 + 2 + 1 records across the three
 * rows; they are moved, not deleted.
 *
 * 1.11.3 also becomes `one_current_version = false`. A multi-document entry
 * holds several papers in force at once, one per jurisdiction; leaving it true
 * would make the merge itself supersede four of the five records the moment
 * they landed under one row, which is exactly the failure this review is meant
 * to prevent. Renewals within a jurisdiction are superseded by hand from the
 * record's history.
 *
 * 1.11.10 / 1.11.11 (CLC) — "Remove from the SeaWolf X requirement list. These
 * documents are not applicable to the current yacht profile." The matrix had
 * them Y for every tonnage band; the snapshot now says N below 500 GT. Per-ship
 * applicability is a deliberate override field, so it is NOT re-resolved
 * wholesale — this touches only those two rows, only on vessels under 500 GT,
 * and only where nothing has been filed against them.
 */
export class ApplyV60InsuranceReview20260730000200 implements MigrationInterface {
  name = 'ApplyV60InsuranceReview20260730000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1.11.3: rename, allow several current documents ──
    await queryRunner.query(`
      UPDATE "compliance_doc_master"
         SET "name" = 'P&I Regional Supplements',
             "one_current_version" = false
       WHERE "sfi_code" = '1.11.3'
    `);
    await queryRunner.query(`
      UPDATE "compliance_doc_types"
         SET "name" = 'P&I Regional Supplements',
             "one_current_version" = false
       WHERE "sfi_code" = '1.11.3'
    `);

    // ── tag what is already there, then move Italy and Spain in ──
    await queryRunner.query(`
      UPDATE "compliance_docs" d
         SET "fields" = coalesce(d."fields", '{}'::jsonb) || '{"jurisdiction":"Greece"}'::jsonb
        FROM "compliance_doc_types" t
       WHERE t."id" = d."doc_type_id"
         AND t."sfi_code" = '1.11.3'
         AND coalesce(d."fields", '{}'::jsonb) ->> 'jurisdiction' IS NULL
    `);

    for (const [code, jurisdiction] of [
      ['1.11.4', 'Italy'],
      ['1.11.5', 'Spain'],
    ]) {
      await queryRunner.query(
        `
        UPDATE "compliance_docs" d
           SET "doc_type_id" = target."id",
               "fields" = coalesce(d."fields", '{}'::jsonb)
                          || jsonb_build_object('jurisdiction', $2::text)
          FROM "compliance_doc_types" src
          JOIN "compliance_doc_types" target
            ON target."ship_id" = src."ship_id" AND target."sfi_code" = '1.11.3'
         WHERE src."id" = d."doc_type_id"
           AND src."sfi_code" = $1
        `,
        [code, jurisdiction],
      );
    }

    // Rows are gone once their records have moved. compliance_docs cascades on
    // doc_type_id, so this must run AFTER the move — never before.
    await queryRunner.query(`
      DELETE FROM "compliance_doc_types" WHERE "sfi_code" IN ('1.11.4', '1.11.5')
    `);
    await queryRunner.query(`
      DELETE FROM "compliance_doc_master" WHERE "sfi_code" IN ('1.11.4', '1.11.5')
    `);

    // ── 1.11.6: "Retain the SeaWolf X and SeaWolf Chase repatriation
    // certificates under 1.11.6… Allow multiple vessel-specific attachments."
    // A row that holds one paper per vessel cannot be a single-current row: the
    // tender's certificate would file the yacht's as superseded the moment it
    // was uploaded, which is the failure this whole review is about.
    await queryRunner.query(`
      UPDATE "compliance_doc_master" SET "one_current_version" = false
       WHERE "sfi_code" IN ('1.11.6', '1.11.7')
    `);
    await queryRunner.query(`
      UPDATE "compliance_doc_types" SET "one_current_version" = false
       WHERE "sfi_code" IN ('1.11.6', '1.11.7')
    `);

    // ── CLC below 500 GT ──
    await queryRunner.query(`
      UPDATE "compliance_doc_types" t
         SET "applicability" = 'N'
        FROM "ships" s
       WHERE s."id" = t."ship_id"
         AND t."sfi_code" IN ('1.11.10', '1.11.11')
         AND s."gross_tonnage" IS NOT NULL
         AND s."gross_tonnage" < 500
         AND NOT EXISTS (
           SELECT 1 FROM "compliance_docs" d WHERE d."doc_type_id" = t."id"
         )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The 1.11.4 / 1.11.5 rows can be recreated from the snapshot, but which
    // records came from which is only recoverable through the jurisdiction tag
    // written above — so this reverses the reversible half and leaves the
    // merged records where they are rather than guessing them apart.
    await queryRunner.query(`
      UPDATE "compliance_doc_master"
         SET "name" = 'P&I — Regional Supplement (Greece)',
             "one_current_version" = true
       WHERE "sfi_code" = '1.11.3'
    `);
    await queryRunner.query(`
      UPDATE "compliance_doc_types"
         SET "name" = 'P&I — Regional Supplement (Greece)',
             "one_current_version" = true
       WHERE "sfi_code" = '1.11.3'
    `);
    await queryRunner.query(`
      UPDATE "compliance_doc_types"
         SET "applicability" = 'Y'
       WHERE "sfi_code" IN ('1.11.10', '1.11.11') AND "applicability" = 'N'
    `);
    for (const table of ['compliance_doc_master', 'compliance_doc_types']) {
      await queryRunner.query(`
        UPDATE "${table}" SET "one_current_version" = true
         WHERE "sfi_code" IN ('1.11.6', '1.11.7')
      `);
    }
  }
}
