import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D3 of the doc-control schema — the Link_Model. One compliance document
 * links to MANY assets (or a crew member, for PERSONNEL docs) via a single
 * record, no per-asset copies. Replaces the single compliance_docs.asset_id
 * (which is kept, deprecated, for back-compat).
 *
 * link_role  : certifies | services | type_approves | documents | covers
 * match_method: system_generated | extracted_serial | manual_confirm
 * verify_state: auto | confirmed (per link)
 */
export class AddDocAssetLinks20260618000900 implements MigrationInterface {
  name = 'AddDocAssetLinks20260618000900';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "doc_asset_links" (
        "id"             uuid NOT NULL DEFAULT uuid_generate_v4(),
        "doc_id"         uuid NOT NULL,
        "asset_id"       uuid,
        "crew_member_id" uuid,
        "resolution_sfi" varchar(60),
        "link_role"      varchar(16) NOT NULL DEFAULT 'covers',
        "match_method"   varchar(20) NOT NULL DEFAULT 'manual_confirm',
        "verify_state"   varchar(12) NOT NULL DEFAULT 'confirmed',
        "created_at"     timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_doc_asset_links" PRIMARY KEY ("id"),
        CONSTRAINT "FK_dal_doc" FOREIGN KEY ("doc_id")
          REFERENCES "compliance_docs"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_dal_asset" FOREIGN KEY ("asset_id")
          REFERENCES "assets"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_dal_crew" FOREIGN KEY ("crew_member_id")
          REFERENCES "crew_members"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_dal_target" CHECK (
          ("asset_id" IS NOT NULL AND "crew_member_id" IS NULL) OR
          ("asset_id" IS NULL AND "crew_member_id" IS NOT NULL)
        )
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_dal_doc" ON "doc_asset_links" ("doc_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dal_asset" ON "doc_asset_links" ("asset_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_dal_doc_asset" ON "doc_asset_links" ("doc_id", "asset_id")`,
    );

    // Migrate existing single asset_id links into the join (manual, confirmed).
    await queryRunner.query(`
      INSERT INTO "doc_asset_links" ("doc_id", "asset_id", "link_role", "match_method", "verify_state")
      SELECT "id", "asset_id", 'covers', 'manual_confirm', 'confirmed'
      FROM "compliance_docs"
      WHERE "asset_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "doc_asset_links"`);
  }
}
