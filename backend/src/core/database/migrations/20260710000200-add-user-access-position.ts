import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RBAC position becomes a first-class, directly-assignable attribute of a user
 * account (the access-matrix column: master / hod_engine / engine / … / guest).
 * Chosen at user creation so the matrix columns == the roles an admin assigns,
 * instead of being heuristically derived from a linked crew member. Null for
 * admins (full access) and legacy users (fall back to crew-derived position).
 */
export class AddUserAccessPosition20260710000200 implements MigrationInterface {
  name = 'AddUserAccessPosition20260710000200';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "access_position" varchar(32)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "access_position"`,
    );
  }
}
