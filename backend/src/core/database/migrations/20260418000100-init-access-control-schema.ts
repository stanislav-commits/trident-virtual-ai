import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitAccessControlSchema20260418000100 implements MigrationInterface {
  name = 'InitAccessControlSchema20260418000100';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(
      `CREATE TYPE "public"."user_role_enum" AS ENUM('admin', 'user')`,
    );
    await queryRunner.query(`
      CREATE TABLE "ships" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(255) NOT NULL,
        "organization_name" character varying(255),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_ships_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_ships_organization_name" UNIQUE ("organization_name")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" character varying(100) NOT NULL,
        "name" character varying(255),
        "password_hash" character varying(255) NOT NULL,
        "role" "public"."user_role_enum" NOT NULL DEFAULT 'user',
        "ship_id" uuid,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_user_id" UNIQUE ("user_id"),
        CONSTRAINT "CHK_users_role_ship_scope"
          CHECK (
            ("role" = 'admin' AND "ship_id" IS NULL)
            OR ("role" = 'user' AND "ship_id" IS NOT NULL)
          ),
        CONSTRAINT "FK_users_ship_id"
          FOREIGN KEY ("ship_id")
          REFERENCES "ships"("id")
          ON DELETE SET NULL
          ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_users_role" ON "users" ("role")`);
    await queryRunner.query(`CREATE INDEX "IDX_users_ship_id" ON "users" ("ship_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_users_ship_id"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_users_role"`);
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TABLE "ships"`);
    await queryRunner.query(`DROP TYPE "public"."user_role_enum"`);
  }
}
