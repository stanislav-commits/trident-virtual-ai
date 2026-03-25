ALTER TABLE "chat_sessions"
ADD COLUMN "pinned_at" TIMESTAMP(3);

CREATE INDEX "chat_sessions_user_id_pinned_at_idx"
ON "chat_sessions"("user_id", "pinned_at");
