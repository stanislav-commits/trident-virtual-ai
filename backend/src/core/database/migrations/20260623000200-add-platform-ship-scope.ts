import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Knowledge Base redesign (Phase 3, approach B): fleet-wide Publications need
 * an owner. Rather than make documents.ship_id nullable (a wide cascade), we
 * introduce a single hidden "platform" ship row that owns Publications and
 * their shared RAGFlow dataset. Adds `ships.is_platform` and seeds the row with
 * a fixed id (see platform-ship.constants.ts). Idempotent.
 */
export class AddPlatformShipScope20260623000200 implements MigrationInterface {
  name = 'AddPlatformShipScope20260623000200';

  private readonly platformShipId = '00000000-0000-4000-8000-000000000001';
  private readonly platformShipName = 'Platform — Publications';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ships" ADD COLUMN IF NOT EXISTS "is_platform" boolean NOT NULL DEFAULT false`,
    );

    await queryRunner.query(
      `INSERT INTO "ships" ("id", "name", "is_platform")
       VALUES ($1, $2, true)
       ON CONFLICT ("id") DO NOTHING`,
      [this.platformShipId, this.platformShipName],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "ships" WHERE "id" = $1`, [
      this.platformShipId,
    ]);
    await queryRunner.query(
      `ALTER TABLE "ships" DROP COLUMN IF EXISTS "is_platform"`,
    );
  }
}
