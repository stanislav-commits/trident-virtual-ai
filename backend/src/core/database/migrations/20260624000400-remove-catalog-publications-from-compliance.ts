import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Dedup: the fleet-wide reference publications (Category A) now live in the
 * Publications Library catalog (publication_catalog), so they are removed from
 * the Compliance Docs module to avoid duplication. Removes them from BOTH the
 * master (so new ships no longer inherit them) and existing per-ship types.
 *
 * KEPT in compliance: the 15 ship-specific documents that were mislabelled as
 * PUBLICATION (Damage Control Plan, SMS manuals, Fire Safety booklets, Cargo
 * Securing Manual, chart holdings, training records, etc.) — these belong to
 * the vessel, not the fleet-wide library. (RECORD_BOOK / PLAN / other archetype
 * rows in the section are untouched.)
 */
export class RemoveCatalogPublicationsFromCompliance20260624000400
  implements MigrationInterface
{
  name = 'RemoveCatalogPublicationsFromCompliance20260624000400';

  // Ship-specific publications to KEEP in compliance (exact master/type names).
  private readonly keep: string[] = [
    'Cargo Securing Manual (if carrying lifted loads / toys on deck)',
    'Damage Control Plans & Booklet',
    'Dangerous Goods Manifest / Stowage Plan',
    'Drug & Alcohol Policy reference (MLC / ISM derived)',
    'Emergency Response Procedures Manual (SMS)',
    'Fire Safety Operational Booklet',
    'Fire Safety Training Manual',
    'Harmful Substances in Packaged Form Record',
    'Maintenance & Testing Record — LSA/FFA (per SOLAS III/20)',
    'Nautical Charts — Paper or ENC folio for intended voyage',
    'Notices to Mariners — Annual Summary + Weekly updates',
    'Onboard Training Records (STCW A-VI)',
    'Safety of Navigation Manual — Company SMS issue',
    'Ship Structure Access Manual',
    'Training Manual (LSA / Lifeboat / Liferaft operations)',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Remove any compliance records of the to-be-removed types (and their
    //    asset links). Normally none exist (the catalog had 0 uploaded files).
    await queryRunner.query(
      `DELETE FROM "doc_asset_links" WHERE "doc_id" IN (
         SELECT d.id FROM "compliance_docs" d
         JOIN "compliance_doc_types" t ON t.id = d.doc_type_id
         WHERE t.archetype = 'PUBLICATION' AND t.name <> ALL($1)
       )`,
      [this.keep],
    );
    await queryRunner.query(
      `DELETE FROM "compliance_docs" WHERE "doc_type_id" IN (
         SELECT id FROM "compliance_doc_types"
         WHERE archetype = 'PUBLICATION' AND name <> ALL($1)
       )`,
      [this.keep],
    );

    // 2. Per-ship instantiated types.
    await queryRunner.query(
      `DELETE FROM "compliance_doc_types" WHERE archetype = 'PUBLICATION' AND name <> ALL($1)`,
      [this.keep],
    );

    // 3. Master source, so future ships don't re-inherit them.
    await queryRunner.query(
      `DELETE FROM "compliance_doc_master" WHERE archetype = 'PUBLICATION' AND name <> ALL($1)`,
      [this.keep],
    );
  }

  public async down(): Promise<void> {
    // Irreversible without re-seeding the compliance master; the publications
    // now live in the publication_catalog instead.
  }
}
