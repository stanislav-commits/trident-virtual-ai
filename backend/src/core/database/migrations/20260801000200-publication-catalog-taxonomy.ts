import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Taxonomy for the Regs4Ships publications load: the platform Publications
 * catalog grows from 32 hand-made slots to ~1 100 merged library documents,
 * and a flat list stops working for everyone. `category` groups the admin
 * tree ("SOLAS", "Malta", "LR ShipRight"…), `jurisdiction` is what a future
 * flag-scoped retrieval filter keys off (international / uk / eu / flag:MT /
 * class:LR), `series` names the merge group a document belongs to — the unit
 * a monthly refresh regenerates. All three stay NULL on the original slots.
 */
export class PublicationCatalogTaxonomy20260801000200
  implements MigrationInterface
{
  name = 'PublicationCatalogTaxonomy20260801000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "publication_catalog"
        ADD COLUMN "category" character varying(80),
        ADD COLUMN "jurisdiction" character varying(30),
        ADD COLUMN "series" character varying(160),
        ADD COLUMN "contents" text
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_publication_catalog_category"
        ON "publication_catalog" ("category")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_publication_catalog_category"`,
    );
    await queryRunner.query(`
      ALTER TABLE "publication_catalog"
        DROP COLUMN "contents",
        DROP COLUMN "series",
        DROP COLUMN "jurisdiction",
        DROP COLUMN "category"
    `);
  }
}
