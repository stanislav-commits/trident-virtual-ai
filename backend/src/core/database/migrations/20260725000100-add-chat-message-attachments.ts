import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Image attachments on chat messages — the "+ attach photo" flow: the crew
 * sends a photo with their question and the assistant SEES it (Claude
 * vision). Binaries live in Spaces / the local spool under
 * chat-attachments/<sessionId>/<attachmentId>; this jsonb holds metadata.
 */
export class AddChatMessageAttachments20260725000100
  implements MigrationInterface
{
  name = 'AddChatMessageAttachments20260725000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" ADD COLUMN IF NOT EXISTS "attachments" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "attachments"`,
    );
  }
}
