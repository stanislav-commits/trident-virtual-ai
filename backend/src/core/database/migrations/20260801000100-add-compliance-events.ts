import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * v60 Phase 4 — the event layer of the compliance register.
 *
 * - `compliance_events`: audit trail of vessel/operational events (flag
 *   change, structural alteration, equipment replaced…).
 * - `trigger_codes` on types + master: which events a document reacts to.
 * - `compliance_type_relations`: parent → child dependency edges (DOC → SMC,
 *   SSP → ISSC, DMLC → MLC…). Parent replaced ⇒ child records flagged.
 * - `review_flag` on records: the TO-REVIEW outcome.
 *
 * Seeding is by NAME pattern, never by code — v60 renumbered the 1.6–1.8
 * block, so codes lie (its 1.6 is our 1.7). Patterns were verified against
 * the live catalogue on 2026-08-01. The Behaviour Matrix "Trigger Date /
 * Event" text has no machine-readable source column (update_trigger is NULL
 * on all 303 rows), so each code → row mapping here is the hand-made seed
 * the analysis said Phase 4 would need.
 */
export class AddComplianceEvents20260801000100 implements MigrationInterface {
  name = 'AddComplianceEvents20260801000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "compliance_events" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "ship_id" uuid NOT NULL,
        "code" character varying(60) NOT NULL,
        "source" character varying(40) NOT NULL DEFAULT 'manual',
        "note" text,
        "payload" jsonb,
        "affected_count" integer NOT NULL DEFAULT 0,
        "created_by" uuid,
        "occurred_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_compliance_events_ship"
        ON "compliance_events" ("ship_id", "occurred_at")
    `);

    await queryRunner.query(`
      ALTER TABLE "compliance_doc_types"
        ADD COLUMN "trigger_codes" text[] NOT NULL DEFAULT '{}'
    `);
    await queryRunner.query(`
      ALTER TABLE "compliance_doc_master"
        ADD COLUMN "trigger_codes" text[] NOT NULL DEFAULT '{}'
    `);

    await queryRunner.query(`
      CREATE TABLE "compliance_type_relations" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "ship_id" uuid NOT NULL,
        "parent_type_id" uuid NOT NULL
          REFERENCES "compliance_doc_types"("id") ON DELETE CASCADE,
        "child_type_id" uuid NOT NULL
          REFERENCES "compliance_doc_types"("id") ON DELETE CASCADE,
        "relation" character varying(30) NOT NULL DEFAULT 'child',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_compliance_type_relation"
          UNIQUE ("parent_type_id", "child_type_id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_compliance_type_relations_ship"
        ON "compliance_type_relations" ("ship_id")
    `);

    await queryRunner.query(`
      ALTER TABLE "compliance_docs" ADD COLUMN "review_flag" jsonb
    `);

    // ── Seed trigger codes (per-ship types AND the master catalogue) ──
    const TRIGGER_SEED: Array<[string, string[]]> = [
      // Tonnage certificates: "Alteration, remeasurement, tonnage change or
      // flag change" (flag only on the international one).
      ['International Tonnage Certificate%', ['structural_change', 'flag_change']],
      ['Tonnage Certificate — Panama%', ['structural_change']],
      ['Tonnage Certificate — Suez%', ['structural_change']],
      // Stability: "Immediate review if vessel configuration no longer
      // matches approved stability documents".
      ['Intact Stability Information Booklet%', ['structural_change']],
      // CSR: "Change to vessel identity, ownership, Flag, company, class".
      ['Continuous Synopsis Record%', ['flag_change', 'vessel_particulars_change']],
      // Docking-cycle survey reports.
      ['Dry Docking Survey Report%', ['dry_docking']],
      ['Tail Shaft Survey Report%', ['dry_docking']],
      ['Rudder Survey Report%', ['dry_docking']],
      // GMDSS fit is defined by the declared sea areas.
      ['Cargo Ship Safety Radio Certificate%', ['sea_area_change']],
      ['Record of Equipment — Cargo Ship Radio%', ['sea_area_change']],
      // Equipment-bound test reports / approvals: TO-INVALID when the linked
      // unit is replaced or unserviceable.
      ['EPIRB Annual Test Report%', ['equipment_replaced', 'equipment_unserviceable']],
      ['Grab Bag EPIRB%', ['equipment_replaced', 'equipment_unserviceable']],
      ['AIS — Annual Test%', ['equipment_replaced', 'equipment_unserviceable']],
      ['SART — Annual Test%', ['equipment_replaced', 'equipment_unserviceable']],
      ['LRIT Conformance Test%', ['equipment_replaced', 'equipment_unserviceable']],
      ['Magnetic Compass Deviation Card%', ['equipment_replaced', 'equipment_unserviceable']],
      ['%Gyro Compass Service Report%', ['equipment_replaced', 'equipment_unserviceable']],
      ['Anchors & Cables Type Approval%', ['equipment_replaced']],
      ['Record of Lifeboats%', ['equipment_replaced', 'equipment_unserviceable']],
    ];
    for (const [pattern, codes] of TRIGGER_SEED) {
      const arr = `{${codes.join(',')}}`;
      await queryRunner.query(
        `UPDATE "compliance_doc_types"
            SET "trigger_codes" = $1
          WHERE "name" ILIKE $2`,
        [arr, pattern],
      );
      await queryRunner.query(
        `UPDATE "compliance_doc_master"
            SET "trigger_codes" = $1
          WHERE "name" ILIKE $2`,
        [arr, pattern],
      );
    }

    // ── Seed dependency edges (parent replaced ⇒ child review) ──
    const RELATION_SEED: Array<[string, string, string]> = [
      // [parent name pattern, child name pattern, relation]
      ['Certificate of Classification', 'Interim Certificate(s) of Class%', 'child'],
      ['Certificate of Compliance — Large Yacht%', 'Record of Equipment — LYC%', 'child'],
      ['%Safety Equipment Certificate%', 'Record of Equipment — SEC%', 'child'],
      ['Cargo Ship Safety Radio Certificate%', 'Record of Equipment — Cargo Ship Radio%', 'child'],
      ['Document of Compliance (DOC)%', 'Safety Management Certificate (SMC)%', 'child'],
      ['Ship Security Plan%', 'International Ship Security Certificate%', 'child'],
      ['Declaration of Maritime Labour Compliance — Part I (DMLC-I)%', 'Maritime Labour Convention Certificate%', 'child'],
      ['Declaration of Maritime Labour Compliance — Part II%', 'Maritime Labour Convention Certificate%', 'child'],
      ['Light Ship Survey Report%', 'Intact Stability Information Booklet%', 'derived'],
      ['Intact Stability Information Booklet%', 'Damaged Stability Information Booklet%', 'derived'],
      ['Intact Stability Information Booklet%', 'Loading & Ballast Manual%', 'derived'],
    ];
    for (const [parent, child, relation] of RELATION_SEED) {
      await queryRunner.query(
        `INSERT INTO "compliance_type_relations"
                ("ship_id", "parent_type_id", "child_type_id", "relation")
         SELECT p."ship_id", p."id", c."id", $3
           FROM "compliance_doc_types" p
           JOIN "compliance_doc_types" c
             ON c."ship_id" = p."ship_id"
            AND c."id" <> p."id"
          WHERE p."name" ILIKE $1
            AND c."name" ILIKE $2
         ON CONFLICT ON CONSTRAINT "UQ_compliance_type_relation" DO NOTHING`,
        [parent, child, relation],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "compliance_docs" DROP COLUMN "review_flag"`,
    );
    await queryRunner.query(`DROP TABLE "compliance_type_relations"`);
    await queryRunner.query(
      `ALTER TABLE "compliance_doc_master" DROP COLUMN "trigger_codes"`,
    );
    await queryRunner.query(
      `ALTER TABLE "compliance_doc_types" DROP COLUMN "trigger_codes"`,
    );
    await queryRunner.query(`DROP TABLE "compliance_events"`);
  }
}
