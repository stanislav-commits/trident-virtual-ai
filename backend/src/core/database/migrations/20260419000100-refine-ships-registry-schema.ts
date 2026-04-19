import { MigrationInterface, QueryRunner } from 'typeorm';

export class RefineShipsRegistrySchema20260419000100 implements MigrationInterface {
  name = 'RefineShipsRegistrySchema20260419000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ships" DROP CONSTRAINT IF EXISTS "UQ_ships_organization_name"`,
    );
    await queryRunner.query(
      `ALTER TABLE "ships" ADD COLUMN IF NOT EXISTS "imo_number" character varying(7)`,
    );
    await queryRunner.query(
      `ALTER TABLE "ships" ADD COLUMN IF NOT EXISTS "build_year" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "ships" ADD CONSTRAINT "CHK_ships_build_year_range" CHECK ("build_year" IS NULL OR ("build_year" >= 1800 AND "build_year" <= 3000))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ships_imo_number" ON "ships" ("imo_number") WHERE "imo_number" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_ships_organization_name" ON "ships" ("organization_name")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ships_organization_name"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_ships_imo_number"`);
    await queryRunner.query(
      `ALTER TABLE "ships" DROP CONSTRAINT IF EXISTS "CHK_ships_build_year_range"`,
    );
    await queryRunner.query(`ALTER TABLE "ships" DROP COLUMN IF EXISTS "build_year"`);
    await queryRunner.query(`ALTER TABLE "ships" DROP COLUMN IF EXISTS "imo_number"`);
    await queryRunner.query(
      `ALTER TABLE "ships" ADD CONSTRAINT "UQ_ships_organization_name" UNIQUE ("organization_name")`,
    );
  }
}
