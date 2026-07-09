import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RBAC access matrix — per-ship overrides of a permission cell
 * (position × resource category → level). Platform defaults live in code
 * (access-positions.ts DEFAULT_MATRIX); this table only stores vessel
 * overrides, so a fresh ship inherits the default with zero rows.
 */
export class AddAccessMatrix20260703000100 implements MigrationInterface {
  name = 'AddAccessMatrix20260703000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "access_matrix_cell" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ship_id" uuid NOT NULL,
        "position" varchar(32) NOT NULL,
        "resource_category" varchar(40) NOT NULL,
        "level" varchar(8) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_access_matrix_cell" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_access_cell" UNIQUE ("ship_id", "position", "resource_category"),
        CONSTRAINT "FK_access_cell_ship" FOREIGN KEY ("ship_id")
          REFERENCES "ships" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_access_cell_ship" ON "access_matrix_cell" ("ship_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "access_matrix_cell"`);
  }
}
