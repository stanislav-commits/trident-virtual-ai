import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `type_approval` — manufacturer approval of an equipment TYPE (MED Module B/D,
 * EC type examination, ATEX, declaration of conformity), stored against the
 * asset rather than in the vessel's certificate register.
 *
 * v60: TYPE_APPROVAL "belongs primarily to the equipment type, not the vessel
 * certificate set", Primary Location "Asset Documents". SeaWolf X alone holds
 * 33 of these with nowhere to put them, and the library forbids removing them
 * from Compliance until asset-document upload exists — this is that upload.
 *
 * Behaves like PLAN: a file store, skipped by both the vision extractor and
 * RAGFlow (see isFileStoreClass / FILE_STORE_CLASSES). Nobody full-text
 * searches a type approval; it is opened from the asset it approves.
 *
 * `doc_class` is a Postgres enum, so the value has to be added to the type
 * itself — adding it to the TypeScript enum alone gets a 22P02 on insert.
 */
export class AddTypeApprovalDocClass20260730000100 implements MigrationInterface {
  name = 'AddTypeApprovalDocClass20260730000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "document_doc_class_enum" ADD VALUE IF NOT EXISTS 'type_approval'
    `);
  }

  public async down(): Promise<void> {
    // Postgres cannot drop a value from an enum type. Removing it would mean
    // rebuilding the type and rewriting every row of `documents`, which is not
    // worth it for an additive change — the value simply stops being used.
  }
}
