-- Preserve existing data and extend metric catalog for InfluxDB synchronization.
ALTER TABLE "MetricDefinition"
  ALTER COLUMN "key" TYPE VARCHAR(255);

ALTER TABLE "ShipMetricsConfig"
  ALTER COLUMN "metric_key" TYPE VARCHAR(255);

ALTER TABLE "MetricDefinition"
  ADD COLUMN IF NOT EXISTS "bucket" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "measurement" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "field" VARCHAR(255),
  ADD COLUMN IF NOT EXISTS "first_seen_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'active';

CREATE INDEX IF NOT EXISTS "MetricDefinition_bucket_status_idx"
  ON "MetricDefinition"("bucket", "status");

-- Existing rows remain valid and become active by default.
UPDATE "MetricDefinition"
SET "status" = 'active'
WHERE "status" IS NULL OR "status" = '';
