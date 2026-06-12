import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 1 of the metric-understanding rebuild: hang rich AI-generated
 * metadata off every row in `ship_metric_catalog`.
 *
 * Two distinct roles for the asset binding:
 *   `bound_asset_id`        — the *effective* binding currently in use
 *                             (FK assets.id, ON DELETE SET NULL so deleting
 *                              an asset doesn't lose the metric).
 *   `ai_bound_confidence`   — how confident the AI was about *its* proposal
 *                             that resulted in this binding. NULL means the
 *                             binding was set manually (admin override).
 *
 * `ai_kind` (gauge/counter/rate/state) is the data shape AI inferred from
 * the statistical fingerprint; `ai_unit` is the canonical unit string.
 *
 * Arrays (`ai_questions_can_answer`, `ai_warnings`) are stored as JSON
 * text — small and easy to query without needing a separate table.
 */
export class AddMetricCatalogAiMetadata20260602000300
  implements MigrationInterface
{
  name = 'AddMetricCatalogAiMetadata20260602000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ship_metric_catalog"
        ADD COLUMN "ai_description"          text,
        ADD COLUMN "ai_kind"                 varchar(20),
        ADD COLUMN "ai_unit"                 varchar(30),
        ADD COLUMN "ai_unit_confidence"      real,
        ADD COLUMN "bound_asset_id"          uuid REFERENCES "assets"("id") ON DELETE SET NULL,
        ADD COLUMN "ai_bound_confidence"     real,
        ADD COLUMN "ai_typical_p5"           double precision,
        ADD COLUMN "ai_typical_p50"          double precision,
        ADD COLUMN "ai_typical_p95"          double precision,
        ADD COLUMN "ai_non_zero_share_pct"   real,
        ADD COLUMN "ai_is_monotonic"         boolean,
        ADD COLUMN "ai_questions_can_answer" text,
        ADD COLUMN "ai_warnings"             text,
        ADD COLUMN "ai_reasoning"            text,
        ADD COLUMN "ai_generated_at"         timestamptz,
        ADD COLUMN "ai_model"                varchar(50)
    `);

    await queryRunner.query(`
      ALTER TABLE "ship_metric_catalog"
      ADD CONSTRAINT "CHK_ship_metric_catalog_ai_kind"
      CHECK (
        "ai_kind" IS NULL OR
        "ai_kind" IN ('gauge','counter','rate','state')
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_ship_metric_catalog_bound_asset"
        ON "ship_metric_catalog" ("bound_asset_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_ship_metric_catalog_ai_kind"
        ON "ship_metric_catalog" ("ai_kind")
        WHERE "ai_kind" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_ship_metric_catalog_ai_generated_at"
        ON "ship_metric_catalog" ("ai_generated_at")
        WHERE "ai_generated_at" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_ship_metric_catalog_ai_generated_at"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_ship_metric_catalog_ai_kind"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_ship_metric_catalog_bound_asset"
    `);

    await queryRunner.query(`
      ALTER TABLE "ship_metric_catalog"
      DROP CONSTRAINT IF EXISTS "CHK_ship_metric_catalog_ai_kind"
    `);

    await queryRunner.query(`
      ALTER TABLE "ship_metric_catalog"
        DROP COLUMN IF EXISTS "ai_model",
        DROP COLUMN IF EXISTS "ai_generated_at",
        DROP COLUMN IF EXISTS "ai_reasoning",
        DROP COLUMN IF EXISTS "ai_warnings",
        DROP COLUMN IF EXISTS "ai_questions_can_answer",
        DROP COLUMN IF EXISTS "ai_is_monotonic",
        DROP COLUMN IF EXISTS "ai_non_zero_share_pct",
        DROP COLUMN IF EXISTS "ai_typical_p95",
        DROP COLUMN IF EXISTS "ai_typical_p50",
        DROP COLUMN IF EXISTS "ai_typical_p5",
        DROP COLUMN IF EXISTS "ai_bound_confidence",
        DROP COLUMN IF EXISTS "bound_asset_id",
        DROP COLUMN IF EXISTS "ai_unit_confidence",
        DROP COLUMN IF EXISTS "ai_unit",
        DROP COLUMN IF EXISTS "ai_kind",
        DROP COLUMN IF EXISTS "ai_description"
    `);
  }
}
