import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMetricSemanticCatalog20260419000600
  implements MigrationInterface
{
  name = 'AddMetricSemanticCatalog20260419000600';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."metric_concepts_type_enum" AS ENUM('single', 'group', 'composite', 'paired', 'comparison', 'trajectory')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."metric_concepts_aggregation_rule_enum" AS ENUM('none', 'sum', 'avg', 'min', 'max', 'last', 'coordinate_pair', 'compare', 'trajectory')`,
    );
    await queryRunner.query(`
      CREATE TABLE "metric_concepts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "slug" character varying(120) NOT NULL,
        "display_name" character varying(255) NOT NULL,
        "description" text,
        "category" character varying(100),
        "type" "public"."metric_concepts_type_enum" NOT NULL,
        "aggregation_rule" "public"."metric_concepts_aggregation_rule_enum" NOT NULL DEFAULT 'none',
        "unit" character varying(50),
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_metric_concepts_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_metric_concepts_slug" ON "metric_concepts" ("slug")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_metric_concepts_category" ON "metric_concepts" ("category")`,
    );
    await queryRunner.query(`
      CREATE TABLE "metric_concept_aliases" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "concept_id" uuid NOT NULL,
        "alias" character varying(255) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_metric_concept_aliases_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_metric_concept_aliases_concept_id"
          FOREIGN KEY ("concept_id")
          REFERENCES "metric_concepts"("id")
          ON DELETE CASCADE
          ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_metric_concept_aliases_concept_alias" ON "metric_concept_aliases" ("concept_id", "alias")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_metric_concept_aliases_alias" ON "metric_concept_aliases" ("alias")`,
    );
    await queryRunner.query(`
      CREATE TABLE "metric_concept_members" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "concept_id" uuid NOT NULL,
        "metric_catalog_id" uuid,
        "child_concept_id" uuid,
        "role" character varying(120),
        "sort_order" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_metric_concept_members_target"
          CHECK (num_nonnulls("metric_catalog_id", "child_concept_id") = 1),
        CONSTRAINT "PK_metric_concept_members_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_metric_concept_members_concept_id"
          FOREIGN KEY ("concept_id")
          REFERENCES "metric_concepts"("id")
          ON DELETE CASCADE
          ON UPDATE NO ACTION,
        CONSTRAINT "FK_metric_concept_members_metric_catalog_id"
          FOREIGN KEY ("metric_catalog_id")
          REFERENCES "ship_metric_catalog"("id")
          ON DELETE CASCADE
          ON UPDATE NO ACTION,
        CONSTRAINT "FK_metric_concept_members_child_concept_id"
          FOREIGN KEY ("child_concept_id")
          REFERENCES "metric_concepts"("id")
          ON DELETE CASCADE
          ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_metric_concept_members_concept_sort" ON "metric_concept_members" ("concept_id", "sort_order")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_metric_concept_members_concept_metric" ON "metric_concept_members" ("concept_id", "metric_catalog_id") WHERE "metric_catalog_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_metric_concept_members_concept_child" ON "metric_concept_members" ("concept_id", "child_concept_id") WHERE "child_concept_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_metric_concept_members_concept_child"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_metric_concept_members_concept_metric"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_metric_concept_members_concept_sort"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "metric_concept_members"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_metric_concept_aliases_alias"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_metric_concept_aliases_concept_alias"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "metric_concept_aliases"`);
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_metric_concepts_category"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_metric_concepts_slug"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "metric_concepts"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."metric_concepts_aggregation_rule_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."metric_concepts_type_enum"`,
    );
  }
}
