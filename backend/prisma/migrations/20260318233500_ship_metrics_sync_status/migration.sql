ALTER TABLE "Ship"
ADD COLUMN "metrics_sync_status" VARCHAR(20) NOT NULL DEFAULT 'idle',
ADD COLUMN "metrics_sync_error" TEXT,
ADD COLUMN "metrics_synced_at" TIMESTAMP(3);

