import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Shelves for the publications rail.
 *
 * The rail was derived from the nodes, so a publication or a category could
 * not exist before a document was put in it — "create Panama, then fill it"
 * was impossible. This table holds the structure itself; the rail merges it
 * with the categories the nodes carry, and seeds itself from what is already
 * loaded so nothing disappears.
 */
export class AddPublicationShelves20260801000400 implements MigrationInterface {
  name = 'AddPublicationShelves20260801000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "publication_shelves" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "publication" character varying(80) NOT NULL,
        "category" character varying(60) NOT NULL,
        "jurisdiction" character varying(30),
        "sort_order" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_publication_shelf" UNIQUE ("publication", "category")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_publication_shelves_sort"
        ON "publication_shelves" ("sort_order")
    `);
    // Seed from what the library already holds.
    await queryRunner.query(`
      INSERT INTO "publication_shelves" ("publication", "category", "jurisdiction")
      SELECT DISTINCT "category", "node_type", MIN("jurisdiction")
        FROM "publication_nodes"
       WHERE "parent_id" IS NULL
       GROUP BY "category", "node_type"
      ON CONFLICT ON CONSTRAINT "UQ_publication_shelf" DO NOTHING
    `);
    // Categories are named by the operator now, not chosen from a fixed list.
    await queryRunner.query(`
      ALTER TABLE "publication_nodes"
        ALTER COLUMN "node_type" TYPE character varying(60)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "publication_nodes"
        ALTER COLUMN "node_type" TYPE character varying(20)
    `);
    await queryRunner.query(`DROP TABLE "publication_shelves"`);
  }
}
