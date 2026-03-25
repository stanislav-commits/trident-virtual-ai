CREATE TABLE "app_settings" (
    "key" VARCHAR(100) NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_id" TEXT,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

ALTER TABLE "app_settings"
ADD CONSTRAINT "app_settings_updated_by_id_fkey"
FOREIGN KEY ("updated_by_id") REFERENCES "users"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
