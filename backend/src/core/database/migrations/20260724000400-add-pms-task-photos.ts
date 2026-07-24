import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Photo attachments on PMS tasks — the "officer saw it → photographed it →
 * assigned it" work-order flow: 'issue' photos document the breakage on an
 * unplanned task, 'completion' photos the finished work at sign-off.
 * Binaries live in Spaces / the local spool (task-photos/ prefix); this
 * jsonb holds the metadata only.
 */
export class AddPmsTaskPhotos20260724000400 implements MigrationInterface {
  name = 'AddPmsTaskPhotos20260724000400';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ADD COLUMN IF NOT EXISTS "photos" jsonb NOT NULL DEFAULT '[]'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" DROP COLUMN IF EXISTS "photos"`,
    );
  }
}
