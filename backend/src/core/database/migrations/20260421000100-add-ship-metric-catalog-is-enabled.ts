import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddShipMetricCatalogIsEnabled20260421000100
  implements MigrationInterface
{
  name = 'AddShipMetricCatalogIsEnabled20260421000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ship_metric_catalog" ADD COLUMN "is_enabled" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ship_metric_catalog" DROP COLUMN IF EXISTS "is_enabled"`,
    );
  }
}
