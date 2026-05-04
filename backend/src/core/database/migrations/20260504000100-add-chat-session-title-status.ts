import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChatSessionTitleStatus20260504000100
  implements MigrationInterface
{
  name = 'AddChatSessionTitleStatus20260504000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chat_sessions"
      ADD COLUMN "title_status" character varying(32) NOT NULL DEFAULT 'auto_initial'
    `);

    await queryRunner.query(`
      UPDATE "chat_sessions"
      SET "title_status" = 'manual'
      WHERE "title" IS NOT NULL
        AND btrim("title") <> ''
        AND lower(btrim("title")) <> 'new chat'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chat_sessions"
      DROP COLUMN IF EXISTS "title_status"
    `);
  }
}
