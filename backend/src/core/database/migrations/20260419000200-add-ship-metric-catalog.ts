import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShipMetricCatalog20260419000200
  implements MigrationInterface
{
  name = 'AddShipMetricCatalog20260419000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ship_metric_catalog" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ship_id" uuid NOT NULL,
        "key" character varying(512) NOT NULL,
        "bucket" character varying(255) NOT NULL,
        "measurement" character varying(255) NOT NULL,
        "field" character varying(255) NOT NULL,
        "description" text,
        "synced_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ship_metric_catalog_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ship_metric_catalog_ship_id"
          FOREIGN KEY ("ship_id")
          REFERENCES "ships"("id")
          ON DELETE CASCADE
          ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_ship_metric_catalog_ship_key" ON "ship_metric_catalog" ("ship_id", "key")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ship_metric_catalog_ship_bucket" ON "ship_metric_catalog" ("ship_id", "bucket")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_ship_metric_catalog_ship_bucket"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_ship_metric_catalog_ship_key"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "ship_metric_catalog"`);
  }
}
