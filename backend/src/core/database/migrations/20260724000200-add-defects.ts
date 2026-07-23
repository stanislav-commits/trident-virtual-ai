import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Defect / failure register (chat-first v1): breakdowns reported in the
 * chat land here; recurrence analytics ("what keeps failing", "what was
 * the cause last time") read from it. Cause/action/parts recorded at
 * closure.
 */
export class AddDefects20260724000200 implements MigrationInterface {
  name = 'AddDefects20260724000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "defects" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "ship_id" uuid NOT NULL,
        "asset_id" uuid REFERENCES "assets"("id") ON DELETE SET NULL,
        "title" varchar(300) NOT NULL,
        "description" text,
        "cause" text,
        "action_taken" text,
        "parts_used" text,
        "status" varchar(12) NOT NULL DEFAULT 'open',
        "reported_on" date NOT NULL,
        "closed_at" timestamptz,
        "reported_by_user_id" uuid,
        "source" varchar(16) NOT NULL DEFAULT 'chat',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_defects_ship_status" ON "defects" ("ship_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_defects_asset" ON "defects" ("asset_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "defects"`);
  }
}
