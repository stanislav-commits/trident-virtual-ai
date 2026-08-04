import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The publications library becomes a tree.
 *
 * The flat catalog could not answer "add a new article to this Malta act" —
 * an article was text inside a merged markdown file, not an object. Nodes are
 * self-referencing with no fixed depth, so Lloyd's (set → Part → Chapter →
 * Section), a Malta act (act → articles), a notice series and a single form
 * are all the same shape, and "add a section" works anywhere.
 *
 * `publication_catalog` is deliberately left alone — it holds the old
 * expected-publications checklist, which stays as it is for now.
 */
export class AddPublicationNodes20260801000300 implements MigrationInterface {
  name = 'AddPublicationNodes20260801000300';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "publication_nodes" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "parent_id" uuid REFERENCES "publication_nodes"("id") ON DELETE CASCADE,
        "category" character varying(80) NOT NULL,
        "node_type" character varying(20) NOT NULL DEFAULT 'other',
        "jurisdiction" character varying(30),
        "number" character varying(60),
        "title" character varying(400) NOT NULL,
        "sort_order" integer NOT NULL DEFAULT 0,
        "content_text" text,
        "document_id" uuid REFERENCES "documents"("id") ON DELETE SET NULL,
        "source_ref" character varying(500),
        "is_ai_document" boolean NOT NULL DEFAULT false,
        "ai_document_id" uuid,
        "text_quality" numeric(3,2),
        "parse_state" character varying(12) NOT NULL DEFAULT 'none',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_publication_nodes_rail"
        ON "publication_nodes" ("category", "node_type")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_publication_nodes_parent"
        ON "publication_nodes" ("parent_id", "sort_order")
    `);
    // The Parse queue and the assembly pass both scan on these.
    await queryRunner.query(`
      CREATE INDEX "IDX_publication_nodes_parse"
        ON "publication_nodes" ("parse_state")
        WHERE "parse_state" <> 'none'
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_publication_nodes_ai_doc"
        ON "publication_nodes" ("is_ai_document")
        WHERE "is_ai_document" = true
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "publication_nodes"`);
  }
}
