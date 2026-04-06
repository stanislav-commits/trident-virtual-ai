ALTER TABLE "ship_manuals"
  ADD COLUMN "semantic_profile" JSONB,
  ADD COLUMN "semantic_profile_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  ADD COLUMN "semantic_profile_version" VARCHAR(64),
  ADD COLUMN "semantic_profile_updated_at" TIMESTAMP(3),
  ADD COLUMN "semantic_profile_error" TEXT;

CREATE INDEX "ship_manuals_semantic_profile_status_idx"
  ON "ship_manuals"("semantic_profile_status");
