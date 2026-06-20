import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D4 of the doc-control schema — Source-of-truth → PMS. A compliance
 * document with a validity/schedule date drives a PMS task (the document
 * wins, the PMS follows). source_doc_id back-references the compliance_docs
 * record that owns the task, so it can be updated/removed when the cert
 * changes. ON DELETE SET NULL keeps the task if the link is severed oddly.
 */
export class AddPmsSourceDoc20260618001000 implements MigrationInterface {
  name = 'AddPmsSourceDoc20260618001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN "source_doc_id" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_pms_tasks_source_doc" ON "pms_tasks" ("source_doc_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "pms_tasks"
         ADD CONSTRAINT "FK_pms_source_doc" FOREIGN KEY ("source_doc_id")
         REFERENCES "compliance_docs"("id") ON DELETE SET NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP CONSTRAINT IF EXISTS "FK_pms_source_doc"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pms_tasks_source_doc"`);
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN IF EXISTS "source_doc_id"`,
    );
  }
}
