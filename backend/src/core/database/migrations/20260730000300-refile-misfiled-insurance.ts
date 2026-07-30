import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two insurance documents are filed under the wrong row. Both were identified
 * from the documents themselves, not from their file names.
 *
 * 1.11.6 holds four records where it should hold two. Two of them are the
 * repatriation certificates the row is for (British Marine 240465/1 for the
 * yacht, 240457/1 for the tender). The other two are QBE certificates numbered
 * 903333/001 whose text is an Italian territorial-waters liability confirmation
 * — "regional third-party liability confirmations [that] do not evidence MLC
 * repatriation security". They belong under the merged regional-supplements row
 * and are tagged Italy on the way. The pair are byte-identical duplicates of
 * one certificate; the older is filed as superseded rather than deleted, so the
 * duplication stays visible.
 *
 * 1.11.1 (Hull & Machinery) holds the Water Quality Insurance Syndicate
 * "Worldwide Vessel Pollution Policy", which is pollution liability, not hull
 * cover. It moves to 1.11.16.
 *
 * Matched on issuer + certificate number rather than file name — the names in
 * this corpus are unreliable (a folder called "CLC Blue Card" turned out to
 * hold MLC certificates). Nothing matches on the local database; these records
 * exist on production.
 */
export class RefileMisfiledInsurance20260730000300 implements MigrationInterface {
  name = 'RefileMisfiledInsurance20260730000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Italian liability certificates: 1.11.6 → 1.11.3, tagged Italy ──
    await queryRunner.query(`
      UPDATE "compliance_docs" d
         SET "doc_type_id" = target."id",
             "fields" = coalesce(d."fields", '{}'::jsonb)
                        || '{"jurisdiction":"Italy"}'::jsonb
        FROM "compliance_doc_types" src
        JOIN "compliance_doc_types" target
          ON target."ship_id" = src."ship_id" AND target."sfi_code" = '1.11.3'
       WHERE src."id" = d."doc_type_id"
         AND src."sfi_code" = '1.11.6'
         AND d."cert_no" = '903333/001'
         AND d."issuer" ILIKE 'QBE%'
    `);

    // The two are duplicates of one certificate. Keep the newest as current and
    // file the rest behind it, which is what "review whether one supersedes the
    // other" asks for, without discarding anything.
    await queryRunner.query(`
      WITH ranked AS (
        SELECT d."id",
               row_number() OVER (
                 PARTITION BY d."ship_id", d."cert_no"
                 ORDER BY d."created_at" DESC, d."id" DESC
               ) AS rn,
               first_value(d."id") OVER (
                 PARTITION BY d."ship_id", d."cert_no"
                 ORDER BY d."created_at" DESC, d."id" DESC
               ) AS keeper
          FROM "compliance_docs" d
          JOIN "compliance_doc_types" t ON t."id" = d."doc_type_id"
         WHERE t."sfi_code" = '1.11.3'
           AND d."cert_no" = '903333/001'
           AND d."record_state" = 'current'
      )
      UPDATE "compliance_docs" d
         SET "record_state" = 'superseded',
             "superseded_by_doc_id" = ranked."keeper",
             "archived_at" = now()
        FROM ranked
       WHERE ranked."id" = d."id" AND ranked.rn > 1
    `);

    // ── pollution policy: 1.11.1 → 1.11.16 ──
    await queryRunner.query(`
      UPDATE "compliance_docs" d
         SET "doc_type_id" = target."id"
        FROM "compliance_doc_types" src
        JOIN "compliance_doc_types" target
          ON target."ship_id" = src."ship_id" AND target."sfi_code" = '1.11.16'
       WHERE src."id" = d."doc_type_id"
         AND src."sfi_code" = '1.11.1'
         AND d."issuer" ILIKE '%Water Quality%'
    `);

    // Anything a moved record had superseded comes back into force. While the
    // pollution policy sat under Hull & Machinery it looked like a newer issue
    // of the hull cover and filed the real hull confirmation away; leaving that
    // standing would empty the H&M row the moment the policy left it.
    await queryRunner.query(`
      UPDATE "compliance_docs" d
         SET "record_state" = 'current',
             "superseded_by_doc_id" = NULL,
             "archived_at" = NULL
        FROM "compliance_docs" mover
        JOIN "compliance_doc_types" mt ON mt."id" = mover."doc_type_id"
       WHERE d."superseded_by_doc_id" = mover."id"
         AND d."record_state" = 'superseded'
         AND d."doc_type_id" <> mover."doc_type_id"
         AND mt."sfi_code" IN ('1.11.3', '1.11.16')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "compliance_docs" d
         SET "doc_type_id" = target."id"
        FROM "compliance_doc_types" src
        JOIN "compliance_doc_types" target
          ON target."ship_id" = src."ship_id" AND target."sfi_code" = '1.11.1'
       WHERE src."id" = d."doc_type_id"
         AND src."sfi_code" = '1.11.16'
         AND d."issuer" ILIKE '%Water Quality%'
    `);
    await queryRunner.query(`
      UPDATE "compliance_docs" d
         SET "doc_type_id" = target."id",
             "record_state" = 'current',
             "superseded_by_doc_id" = NULL,
             "archived_at" = NULL,
             "fields" = d."fields" - 'jurisdiction'
        FROM "compliance_doc_types" src
        JOIN "compliance_doc_types" target
          ON target."ship_id" = src."ship_id" AND target."sfi_code" = '1.11.6'
       WHERE src."id" = d."doc_type_id"
         AND src."sfi_code" = '1.11.3'
         AND d."cert_no" = '903333/001'
         AND d."issuer" ILIKE 'QBE%'
    `);
  }
}
