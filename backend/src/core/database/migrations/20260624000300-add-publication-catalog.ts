import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Publications Library catalog: the fleet-wide list of expected publications
 * (Category A — COLREGs, SOLAS, MARPOL, IMO codes, Admiralty/ITU references).
 * Each row is a slot an admin later uploads a file to. Seeds the agreed 59
 * Category-A titles (13 carry a flag/voyage conditional note). Idempotent seed.
 */
export class AddPublicationCatalog20260624000300 implements MigrationInterface {
  name = 'AddPublicationCatalog20260624000300';

  // [title, conditionalNote|null]
  private readonly seed: Array<[string, string | null]> = [
    ['Admiralty List of Lights & Fog Signals (ALL) Vols A–L', null],
    ['ALRS Vol 1 — Coast Radio Stations', null],
    ['ALRS Vol 2 — Radio Aids to Navigation', null],
    ['ALRS Vol 3 — Maritime Safety Info', null],
    ['ALRS Vol 4 — Meteorological Observations', null],
    ['ALRS Vol 5 — GMDSS', null],
    ['ALRS Vol 6 — Pilot Services, VTS & Ports', null],
    ['Admiralty Tide Tables (ATT) / Tidal Stream Atlases', 'holdings by region'],
    ['Bridge Procedures Guide (ICS)', null],
    ['COLREGs — International Regulations for Preventing Collisions at Sea', null],
    ['Commercial Yacht Code (CYC) — Malta / flag-specific', 'flag-specific'],
    ['COSWP — Code of Safe Working Practices for Merchant Seafarers (MCA)', null],
    ['Flag State Marine Notices / Circulars (non-UK flags)', 'flag-specific'],
    ['Flag State Medical Chest Formulary', 'flag-specific'],
    ['FSS Code — International Code for Fire Safety Systems', null],
    ['GMDSS Manual (latest edition)', null],
    ['Guide to Helicopter/Ship Operations (ICS)', null],
    ['HSC Code — High-Speed Craft', null],
    ['IALA Maritime Buoyage System Guide', null],
    ['IAMSAR Manual Volume III — Mobile Facilities', null],
    ['IBC / IGC / BCH Codes', null],
    ['IMDG Code — International Maritime Dangerous Goods Code', null],
    ['IMO Model Course / Training Reference Library', null],
    ["IMO Ship's Routeing Guide", null],
    ['IMSBC Code — Solid Bulk Cargoes', null],
    ['International Code of Signals (ICS)', null],
    ['International Medical Guide for Ships (IMGS / WHO)', null],
    ['IS Code 2008 — International Code on Intact Stability', null],
    ['ISM Code — International Safety Management Code', null],
    ['ISPS Code — International Ship & Port Facility Security Code', null],
    ['ITU List of Call Signs & Numerical Identities (List VII A)', null],
    ['ITU List of Coast Stations (List IV)', null],
    ['ITU List of Radiodetermination & Special Service Stations (List VI)', null],
    ['ITU List of Ship Stations (List V)', null],
    ['ITU Manual for Maritime Mobile & Maritime Mobile-Satellite Services', null],
    ['Load Line Convention — Consolidated Edition', null],
    ['LSA Code — International Life-Saving Appliances Code', null],
    ['LY3 — Large Commercial Yacht Code (legacy)', 'flag / grandfathered'],
    ["Mariner's Handbook (NP100)", null],
    ['MARPOL — Consolidated Edition (latest)', null],
    ['MCA MGN / MSN / MIN Notices', 'flag-specific subscription'],
    ['Medical First Aid Guide (MFAG)', null],
    ['MLC 2006 — Maritime Labour Convention (Consolidated)', null],
    ['MOB / Person-in-Water Recovery Guide', null],
    ['National Maritime Regulations (Flag State)', 'flag-specific'],
    ['Ocean Passages for the World (NP136)', null],
    ['Polar Code — International Code for Ships Operating in Polar Waters', 'if operating polar'],
    ['PYC — Passenger Yacht Code', 'if applicable'],
    ['REG Yacht Code — Common Annexes', 'flag (Red Ensign Group)'],
    ['REG Yacht Code — Part A (current edition)', 'flag'],
    ['REG Yacht Code — Part B (current edition)', 'flag'],
    ['Sailing Directions / Pilot Books', 'holdings by voyage area'],
    ["Ship Captain's Medical Guide (MCA)", null],
    ['SOLAS — Consolidated Edition (latest)', null],
    ['Standard Marine Communication Phrases (SMCP)', null],
    ['STCW Convention & Code — Consolidated Edition (Manila Amendments)', null],
    ['Symbols & Abbreviations used on Admiralty Charts (NP5011)', null],
    ['Tonnage Convention (ITC 1969)', null],
    ['WHO International Health Regulations (IHR) summary', null],
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "publication_catalog" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" varchar(300) NOT NULL,
        "conditional_note" varchar(120),
        "sort_order" integer NOT NULL DEFAULT 0,
        "document_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_publication_catalog" PRIMARY KEY ("id"),
        CONSTRAINT "FK_publication_catalog_document" FOREIGN KEY ("document_id")
          REFERENCES "documents"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_publication_catalog_sort" ON "publication_catalog" ("sort_order")`,
    );

    for (let i = 0; i < this.seed.length; i += 1) {
      const [title, note] = this.seed[i];
      await queryRunner.query(
        `INSERT INTO "publication_catalog" ("title", "conditional_note", "sort_order")
         SELECT $1::varchar, $2::varchar, $3::int
         WHERE NOT EXISTS (SELECT 1 FROM "publication_catalog" WHERE "title" = $1::varchar)`,
        [title, note, i + 1],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "publication_catalog"`);
  }
}
