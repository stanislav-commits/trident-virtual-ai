import { MigrationInterface, QueryRunner } from 'typeorm';

export class RemoveShipMetricCatalogMeasurement20260419000300
  implements MigrationInterface
{
  name = 'RemoveShipMetricCatalogMeasurement20260419000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ship_metric_catalog"
      DROP COLUMN IF EXISTS "measurement"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "ship_metric_catalog"
      ADD COLUMN "measurement" character varying(255)
    `);
    await queryRunner.query(`
      UPDATE "ship_metric_catalog"
      SET "measurement" = split_part("key", '::', 2)
    `);
    await queryRunner.query(`
      ALTER TABLE "ship_metric_catalog"
      ALTER COLUMN "measurement" SET NOT NULL
    `);
  }
}
