import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widen pms_tasks.sfi_group from varchar(10) to varchar(64). AI import maps a
 * source "group name" column into this field (e.g. "MCLEAN LO TRANSFER"), which
 * overflowed the old 10-char code column and silently dropped those tasks.
 */
export class WidenPmsTaskSfiGroup20260710000500 implements MigrationInterface {
  name = 'WidenPmsTaskSfiGroup20260710000500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ALTER COLUMN "sfi_group" TYPE varchar(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "pms_tasks" ALTER COLUMN "sfi_group" TYPE varchar(10)`,
    );
  }
}
