import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Metric alerts received from Grafana (webhook contact point). One row per
 * Grafana series (fingerprint); re-fires update in place, "resolved" closes it.
 * ship_id / asset_id are nullable so a malformed or unbound payload is still
 * captured rather than dropped.
 */
export class AddAlerts20260622000100 implements MigrationInterface {
  name = 'AddAlerts20260622000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "alerts" (
        "id"               uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ship_id"          uuid,
        "asset_id"         uuid,
        "metric_key"       varchar(512),
        "rule_name"        varchar(255) NOT NULL,
        "severity"         varchar(16) NOT NULL DEFAULT 'warning',
        "status"           varchar(12) NOT NULL DEFAULT 'firing',
        "value"            double precision,
        "title"            varchar(300) NOT NULL,
        "message"          text,
        "department"       varchar(16),
        "labels"           jsonb,
        "fingerprint"      varchar(128) NOT NULL,
        "started_at"       timestamptz NOT NULL,
        "resolved_at"      timestamptz,
        "last_seen_at"     timestamptz NOT NULL,
        "pms_task_id"      uuid,
        "acked_at"         timestamptz,
        "acked_by_user_id" uuid,
        "created_at"       timestamptz NOT NULL DEFAULT now(),
        "updated_at"       timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_alerts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_alerts_asset" FOREIGN KEY ("asset_id")
          REFERENCES "assets"("id") ON DELETE SET NULL,
        CONSTRAINT "FK_alerts_task" FOREIGN KEY ("pms_task_id")
          REFERENCES "pms_tasks"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_alerts_ship_status" ON "alerts" ("ship_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_alerts_asset" ON "alerts" ("asset_id")`,
    );
    // One active (firing) row per Grafana series — the dedup guarantee.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_alerts_active_fingerprint" ON "alerts" ("fingerprint") WHERE "status" = 'firing'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "alerts"`);
  }
}
