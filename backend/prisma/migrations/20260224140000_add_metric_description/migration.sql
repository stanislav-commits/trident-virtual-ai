-- Add description to MetricDefinition only (no other schema changes)
ALTER TABLE "MetricDefinition" ADD COLUMN IF NOT EXISTS "description" TEXT;
