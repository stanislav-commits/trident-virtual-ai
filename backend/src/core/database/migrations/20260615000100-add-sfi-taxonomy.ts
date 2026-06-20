import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SFI taxonomy catalog — the canonical group → sub-group tree from the SFI
 * Master (SFI_Group_Summary). Reference data; rows are seeded by SfiService on
 * boot from the committed sfi-taxonomy.data.ts (idempotent).
 */
export class AddSfiTaxonomy20260615000100 implements MigrationInterface {
  name = 'AddSfiTaxonomy20260615000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "sfi_taxonomy" (
        "id"           uuid NOT NULL DEFAULT uuid_generate_v4(),
        "code"         varchar(20) NOT NULL UNIQUE,
        "name"         varchar(255) NOT NULL,
        "level"        smallint NOT NULL,
        "group_code"   varchar(10) NOT NULL,
        "parent_code"  varchar(20),
        "default_zone" varchar(8),
        "sort_order"   integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_sfi_taxonomy" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_sfi_taxonomy_group_level" ON "sfi_taxonomy" ("group_code", "level")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "sfi_taxonomy"`);
  }
}
