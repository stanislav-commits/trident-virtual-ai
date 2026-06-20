import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Crew roster (phase 5). Ship-scoped people with a department + rank;
 * optional link to a platform login (user_id) for rank-based access.
 */
export class AddCrew20260618000500 implements MigrationInterface {
  name = 'AddCrew20260618000500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "crew_members" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "ship_id" uuid NOT NULL,
        "name" varchar(120) NOT NULL,
        "department" varchar(16) NOT NULL DEFAULT 'other',
        "rank" varchar(60) NOT NULL,
        "rank_level" integer NOT NULL DEFAULT 5,
        "email" varchar(160),
        "phone" varchar(40),
        "user_id" uuid,
        "active" boolean NOT NULL DEFAULT true,
        "joined_at" date,
        "notes" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_crew_members" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_crew_ship" ON "crew_members" ("ship_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_crew_ship"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "crew_members"`);
  }
}
