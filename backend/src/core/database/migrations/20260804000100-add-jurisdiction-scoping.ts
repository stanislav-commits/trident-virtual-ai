import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Scope the library to the vessel: her flag and her class society.
 *
 * The library now holds 51 000 nodes across 27 publications, and most of it is
 * about a ship that is not this one. A Malta-flagged, RINA-classed yacht has
 * no use for Bahamas orders or Lloyd's rule notes, but retrieval hands every
 * publication document to RAGFlow and lets the embedding decide — which is how
 * an answer about a Maltese requirement comes back quoting Bermuda.
 *
 * Two columns carry the scope:
 *
 *   documents.jurisdiction — copied from the publication shelf the document was
 *     assembled from ("flag:MT", "class:RINA", "international", "eu"). Null
 *     means it is not a publication, or the shelf never said.
 *   ships.publication_flag / ships.publication_class — what the operator picked
 *     for this vessel, in the same vocabulary, so the two can be compared
 *     without a name-to-code table in the middle. They are deliberately
 *     separate from ships.flag and ships.class_society, which are free text a
 *     human wrote and which nothing may depend on for filtering.
 *
 * SeaWolf X is filled in from what she already declares — flag Malta, class
 * RINA — because leaving her unscoped would silently keep the old behaviour.
 */
export class AddJurisdictionScoping20260804000100 implements MigrationInterface {
  name = 'AddJurisdictionScoping20260804000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS jurisdiction varchar(40)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_jurisdiction
        ON documents (jurisdiction)
        WHERE jurisdiction IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE ships
        ADD COLUMN IF NOT EXISTS publication_flag varchar(40),
        ADD COLUMN IF NOT EXISTS publication_class varchar(40)
    `);

    // Documents already assembled keep working: take the jurisdiction from the
    // node that owns them.
    await queryRunner.query(`
      UPDATE documents d
         SET jurisdiction = n.jurisdiction
        FROM publication_nodes n
       WHERE n.ai_document_id = d.id
         AND n.jurisdiction IS NOT NULL
         AND d.jurisdiction IS NULL
    `);

    await queryRunner.query(`
      UPDATE ships
         SET publication_flag = 'flag:MT',
             publication_class = 'class:RINA'
       WHERE lower(flag) = 'malta'
         AND upper(class_society) = 'RINA'
         AND publication_flag IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS idx_documents_jurisdiction`);
    await queryRunner.query(`ALTER TABLE documents DROP COLUMN IF EXISTS jurisdiction`);
    await queryRunner.query(`
      ALTER TABLE ships
        DROP COLUMN IF EXISTS publication_flag,
        DROP COLUMN IF EXISTS publication_class
    `);
  }
}
