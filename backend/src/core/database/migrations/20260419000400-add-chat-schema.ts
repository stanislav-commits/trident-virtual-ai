import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddChatSchema20260419000400 implements MigrationInterface {
  name = 'AddChatSchema20260419000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."chat_message_role_enum" AS ENUM('user', 'assistant', 'system')`,
    );
    await queryRunner.query(`
      CREATE TABLE "chat_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "title" character varying(255),
        "user_id" uuid NOT NULL,
        "ship_id" uuid,
        "pinned_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMPTZ,
        CONSTRAINT "PK_chat_sessions_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_chat_sessions_user_id"
          FOREIGN KEY ("user_id")
          REFERENCES "users"("id")
          ON DELETE CASCADE
          ON UPDATE NO ACTION,
        CONSTRAINT "FK_chat_sessions_ship_id"
          FOREIGN KEY ("ship_id")
          REFERENCES "ships"("id")
          ON DELETE SET NULL
          ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "chat_messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "session_id" uuid NOT NULL,
        "role" "public"."chat_message_role_enum" NOT NULL,
        "content" text NOT NULL,
        "ragflow_context" jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMPTZ,
        CONSTRAINT "PK_chat_messages_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_chat_messages_session_id"
          FOREIGN KEY ("session_id")
          REFERENCES "chat_sessions"("id")
          ON DELETE CASCADE
          ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_sessions_user_updated" ON "chat_sessions" ("user_id", "updated_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_sessions_user_pinned" ON "chat_sessions" ("user_id", "pinned_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_sessions_deleted_at" ON "chat_sessions" ("deleted_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_messages_session_created" ON "chat_messages" ("session_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_chat_messages_deleted_at" ON "chat_messages" ("deleted_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_chat_messages_deleted_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_chat_messages_session_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_chat_sessions_deleted_at"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_chat_sessions_user_pinned"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_chat_sessions_user_updated"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "chat_sessions"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."chat_message_role_enum"`);
  }
}
