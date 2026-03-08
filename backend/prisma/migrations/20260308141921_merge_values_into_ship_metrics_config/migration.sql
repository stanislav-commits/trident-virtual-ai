-- DropIndex
DROP INDEX "MetricDefinition_bucket_status_idx";

-- AlterTable
ALTER TABLE "ShipMetricsConfig" ADD COLUMN     "latest_value" JSONB,
ADD COLUMN     "value_updated_at" TIMESTAMP(3);
