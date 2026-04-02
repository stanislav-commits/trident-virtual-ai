CREATE TABLE "tags" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(255) NOT NULL,
    "category" VARCHAR(100) NOT NULL,
    "subcategory" VARCHAR(100) NOT NULL,
    "item" VARCHAR(150) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tags_key_key" ON "tags"("key");
CREATE INDEX "tags_category_subcategory_idx" ON "tags"("category", "subcategory");
CREATE INDEX "tags_subcategory_idx" ON "tags"("subcategory");

CREATE TABLE "metric_definition_tags" (
    "metric_key" VARCHAR(255) NOT NULL,
    "tag_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_definition_tags_pkey" PRIMARY KEY ("metric_key", "tag_id")
);

CREATE INDEX "metric_definition_tags_tag_id_idx" ON "metric_definition_tags"("tag_id");

ALTER TABLE "metric_definition_tags"
ADD CONSTRAINT "metric_definition_tags_metric_key_fkey"
FOREIGN KEY ("metric_key") REFERENCES "MetricDefinition"("key")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "metric_definition_tags"
ADD CONSTRAINT "metric_definition_tags_tag_id_fkey"
FOREIGN KEY ("tag_id") REFERENCES "tags"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

CREATE TABLE "ship_manual_tags" (
    "ship_manual_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ship_manual_tags_pkey" PRIMARY KEY ("ship_manual_id", "tag_id")
);

CREATE INDEX "ship_manual_tags_tag_id_idx" ON "ship_manual_tags"("tag_id");

ALTER TABLE "ship_manual_tags"
ADD CONSTRAINT "ship_manual_tags_ship_manual_id_fkey"
FOREIGN KEY ("ship_manual_id") REFERENCES "ship_manuals"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "ship_manual_tags"
ADD CONSTRAINT "ship_manual_tags_tag_id_fkey"
FOREIGN KEY ("tag_id") REFERENCES "tags"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
