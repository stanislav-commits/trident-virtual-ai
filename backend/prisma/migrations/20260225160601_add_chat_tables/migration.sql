-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('user', 'assistant', 'system');

-- DropForeignKey
ALTER TABLE "telemetry_history" DROP CONSTRAINT "telemetry_history_ship_id_fkey";

-- AlterTable
ALTER TABLE "Ship" ALTER COLUMN "id" DROP DEFAULT;

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(500),
    "user_id" TEXT NOT NULL,
    "ship_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "ragflow_context" JSONB,
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_context_references" (
    "id" TEXT NOT NULL,
    "message_id" TEXT NOT NULL,
    "ship_manual_id" TEXT,
    "chunk_id" TEXT,
    "score" DOUBLE PRECISION,
    "page_number" INTEGER,
    "start_offset" INTEGER,
    "end_offset" INTEGER,
    "snippet" TEXT,
    "source_title" TEXT,
    "source_url" TEXT,

    CONSTRAINT "chat_context_references_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_sessions_user_id_updated_at_idx" ON "chat_sessions"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "chat_sessions_ship_id_idx" ON "chat_sessions"("ship_id");

-- CreateIndex
CREATE INDEX "chat_sessions_created_at_idx" ON "chat_sessions"("created_at");

-- CreateIndex
CREATE INDEX "chat_messages_session_id_created_at_idx" ON "chat_messages"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "chat_context_references_message_id_idx" ON "chat_context_references"("message_id");

-- CreateIndex
CREATE INDEX "chat_context_references_ship_manual_id_idx" ON "chat_context_references"("ship_manual_id");

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_ship_id_fkey" FOREIGN KEY ("ship_id") REFERENCES "Ship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_context_references" ADD CONSTRAINT "chat_context_references_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_context_references" ADD CONSTRAINT "chat_context_references_ship_manual_id_fkey" FOREIGN KEY ("ship_manual_id") REFERENCES "ship_manuals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
