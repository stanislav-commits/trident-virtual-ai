import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Publications Library (compliance section 1.17) carried legacy sparse codes
 * (1.17.30, 1.17.41, 1.17.60…1.17.98 plus two strays from other sections —
 * 1.2.14, 1.15.21) left over from the Cat-A publications removal. Renumber
 * the section sequentially 1.17.1…1.17.N, preserving the current display
 * order (numeric code sort).
 *
 * The mapping is built ONCE from the master matrix and applied to BOTH
 * compliance_doc_master and every ship's compliance_doc_types — the two are
 * matched by sfi_code (instantiateForShip dedup key), so they must move
 * together or re-instantiation would duplicate types. Two-phase rename (TMP
 * prefix) because the new range overlaps the old one and both tables have
 * unique indexes on the code.
 */
export class RenumberPublicationsLibrary20260711000200
  implements MigrationInterface
{
  name = 'RenumberPublicationsLibrary20260711000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Old code → new sequential code, ordered like the UI sorts (numeric by
    // dot-separated segments).
    await queryRunner.query(`
      CREATE TEMP TABLE pub_renumber ON COMMIT DROP AS
      SELECT
        sfi_code AS old_code,
        '1.17.' || ROW_NUMBER() OVER (
          ORDER BY string_to_array(sfi_code, '.')::int[]
        ) AS new_code
      FROM compliance_doc_master
      WHERE section_code = '1.17'
    `);

    // Phase 1: move to a collision-free TMP namespace.
    await queryRunner.query(`
      UPDATE compliance_doc_master t
      SET sfi_code = 'TMP.' || r.new_code
      FROM pub_renumber r
      WHERE t.section_code = '1.17' AND t.sfi_code = r.old_code
    `);
    await queryRunner.query(`
      UPDATE compliance_doc_types t
      SET sfi_code = 'TMP.' || r.new_code
      FROM pub_renumber r
      WHERE t.section_code = '1.17' AND t.sfi_code = r.old_code
    `);

    // Phase 2: strip the TMP prefix.
    await queryRunner.query(`
      UPDATE compliance_doc_master
      SET sfi_code = substring(sfi_code FROM 5)
      WHERE section_code = '1.17' AND sfi_code LIKE 'TMP.%'
    `);
    await queryRunner.query(`
      UPDATE compliance_doc_types
      SET sfi_code = substring(sfi_code FROM 5)
      WHERE section_code = '1.17' AND sfi_code LIKE 'TMP.%'
    `);
  }

  public async down(): Promise<void> {
    // Irreversible renumber (old sparse codes are not retained); restoring
    // them would need the pre-migration backup.
  }
}
