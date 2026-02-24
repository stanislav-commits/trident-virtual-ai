-- User: optional link to one ship (user can be assigned to at most one ship)
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ship_id" UUID NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_ship_id_fkey'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_ship_id_fkey"
      FOREIGN KEY ("ship_id") REFERENCES "Ship"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Ship: optional RAGFlow dataset id (for RAG integration later)
ALTER TABLE "Ship" ADD COLUMN IF NOT EXISTS "ragflow_dataset_id" VARCHAR(255) NULL;

-- Ship manuals: documents per ship for RAG (one dataset per ship variant)
CREATE TABLE IF NOT EXISTS "ship_manuals" (
  "id" TEXT NOT NULL,
  "ship_id" UUID NOT NULL,
  "ragflow_document_id" VARCHAR(255) NOT NULL,
  "filename" VARCHAR(500) NOT NULL,
  "uploaded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ship_manuals_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ship_manuals_ship_id_fkey'
  ) THEN
    ALTER TABLE "ship_manuals"
      ADD CONSTRAINT "ship_manuals_ship_id_fkey"
      FOREIGN KEY ("ship_id") REFERENCES "Ship"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "ship_manuals_ship_id_ragflow_document_id_key"
  ON "ship_manuals"("ship_id", "ragflow_document_id");
