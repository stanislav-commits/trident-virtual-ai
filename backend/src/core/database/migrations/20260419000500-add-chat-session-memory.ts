import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChatSessionMemory20260419000500
  implements MigrationInterface
{
  name = 'AddChatSessionMemory20260419000500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "chat_session_memories" (
        "session_id" uuid NOT NULL,
        "summary" text,
        "covered_message_count" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_chat_session_memories_session_id" PRIMARY KEY ("session_id"),
        CONSTRAINT "FK_chat_session_memories_session_id"
          FOREIGN KEY ("session_id")
          REFERENCES "chat_sessions"("id")
          ON DELETE CASCADE
          ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_chat_session_memories_updated_at"
      ON "chat_session_memories" ("updated_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_chat_session_memories_updated_at"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_session_memories"`);
  }
}
