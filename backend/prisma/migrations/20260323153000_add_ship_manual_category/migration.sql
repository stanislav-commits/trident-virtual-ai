ALTER TABLE "ship_manuals"
ADD COLUMN IF NOT EXISTS "category" VARCHAR(32) NOT NULL DEFAULT 'MANUALS';

CREATE INDEX IF NOT EXISTS "ship_manuals_ship_id_category_idx"
ON "ship_manuals"("ship_id", "category");
