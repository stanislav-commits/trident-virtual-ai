import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v60 Rule 6: "For dependency-driven documents … do not use a fictitious
 * expiry date."
 *
 * Event/dependency/permanent-driven documents had expiry dates copied off the
 * paper by extraction — the LRIT Conformance Test (the spec's own example of
 * SR-DEFINED-CHANGE, "display as Current with no artificial expiry date") was
 * reading EXPIRED in the register off a 2025 date. The date itself stays in
 * `fields` (all affected rows hold it under expiry_date / next_due_date);
 * only the derived status column is cleared. The service now refuses to
 * re-derive expiry for these drivers, so the rows stay clean.
 *
 * Verified on prod 2026-07-31: 4 rows (2× Record of Equipment, LRIT, MSMD),
 * each with the value mirrored in fields.
 */
export class ClearNonTimeExpiry20260731001000 implements MigrationInterface {
  name = 'ClearNonTimeExpiry20260731001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "compliance_docs" d
         SET "expiry_date" = NULL
        FROM "compliance_doc_types" t
       WHERE t."id" = d."doc_type_id"
         AND d."expiry_date" IS NOT NULL
         AND t."validity_driver" IS NOT NULL
         AND t."validity_driver" <> 'VD-TIME'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Best effort: every row this migration touched carries its date in
    // fields; rows without one (created after the guard) stay null.
    await queryRunner.query(`
      UPDATE "compliance_docs" d
         SET "expiry_date" = COALESCE(
               d."fields"->>'expiry_date',
               d."fields"->>'next_due_date'
             )::date
        FROM "compliance_doc_types" t
       WHERE t."id" = d."doc_type_id"
         AND d."expiry_date" IS NULL
         AND t."validity_driver" IS NOT NULL
         AND t."validity_driver" <> 'VD-TIME'
         AND COALESCE(
               d."fields"->>'expiry_date',
               d."fields"->>'next_due_date'
             ) IS NOT NULL
    `);
  }
}
