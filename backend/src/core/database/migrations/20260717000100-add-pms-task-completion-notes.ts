import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Free-text notes the crew member can leave when performing a task — what
 * they observed, what was replaced, anything the next person should know.
 * Distinct from `description` (the job's own instructions, set by whoever
 * scheduled the task).
 */
export class AddPmsTaskCompletionNotes20260717000100
  implements MigrationInterface
{
  name = 'AddPmsTaskCompletionNotes20260717000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN IF NOT EXISTS "completion_notes" text`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN IF EXISTS "completion_notes"`,
    );
  }
}
