CREATE TABLE "MetricDefinition" (
    "key" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "unit" VARCHAR(20),
    "data_type" VARCHAR(20) NOT NULL DEFAULT 'numeric',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetricDefinition_pkey" PRIMARY KEY ("key")
);

CREATE TABLE "Ship" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(255) NOT NULL,
    "serial_number" VARCHAR(100),
    "last_telemetry" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ship_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Ship_serial_number_key" ON "Ship"("serial_number");

CREATE TABLE "ShipMetricsConfig" (
    "ship_id" UUID NOT NULL,
    "metric_key" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ShipMetricsConfig_pkey" PRIMARY KEY ("ship_id", "metric_key")
);

ALTER TABLE "ShipMetricsConfig" ADD CONSTRAINT "ShipMetricsConfig_ship_id_fkey" FOREIGN KEY ("ship_id") REFERENCES "Ship"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShipMetricsConfig" ADD CONSTRAINT "ShipMetricsConfig_metric_key_fkey" FOREIGN KEY ("metric_key") REFERENCES "MetricDefinition"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "telemetry_history" (
    "id" BIGINT GENERATED ALWAYS AS IDENTITY,
    "ship_id" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telemetry_history_pkey" PRIMARY KEY ("id", "created_at"),
    CONSTRAINT "telemetry_history_ship_id_fkey" FOREIGN KEY ("ship_id") REFERENCES "Ship"("id") ON DELETE RESTRICT ON UPDATE CASCADE
) PARTITION BY RANGE ("created_at");

CREATE TABLE "telemetry_history_2026_02" PARTITION OF "telemetry_history"
    FOR VALUES FROM ('2026-02-01 00:00:00+00') TO ('2026-03-01 00:00:00+00');

CREATE TABLE "telemetry_history_2026_03" PARTITION OF "telemetry_history"
    FOR VALUES FROM ('2026-03-01 00:00:00+00') TO ('2026-04-01 00:00:00+00');
