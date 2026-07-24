import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One-time Users↔Crew reconciliation (observed desync on prod 2026-07-24):
 *
 * 1. Crew rows whose linked login was deleted from the old Users tab keep a
 *    dangling user_id — which permanently blocks issuing a new login from
 *    the roster ("already has a login"). Null those links out.
 *
 * 2. Vessel logins created directly from the old Users "Add user" flow have
 *    no roster entry at all — invisible in Crew, unmanageable from it.
 *    Backfill a crew_members row for each (department/rank derived from the
 *    account's access position) and link it, making the roster the single
 *    source of truth going forward (the Users tab now only creates admins).
 *
 * Down is a no-op: this is a data repair, not a schema change.
 */
export class SyncUsersCrew20260724000500 implements MigrationInterface {
  name = 'SyncUsersCrew20260724000500';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE crew_members cm SET user_id = NULL
      WHERE cm.user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = cm.user_id)
    `);

    await queryRunner.query(`
      INSERT INTO crew_members
        (ship_id, name, department, rank, rank_level, user_id, active)
      SELECT
        u.ship_id,
        LEFT(COALESCE(NULLIF(TRIM(u.name), ''), u.user_id), 120),
        CASE u.access_position
          WHEN 'master' THEN 'deck'
          WHEN 'hod_deck' THEN 'deck'
          WHEN 'deck' THEN 'deck'
          WHEN 'hod_engine' THEN 'engine'
          WHEN 'engine' THEN 'engine'
          WHEN 'hod_interior' THEN 'interior'
          WHEN 'interior' THEN 'interior'
          WHEN 'hod_galley' THEN 'galley'
          WHEN 'galley' THEN 'galley'
          ELSE 'other'
        END,
        CASE u.access_position
          WHEN 'master' THEN 'Master'
          WHEN 'hod_deck' THEN 'Chief Officer'
          WHEN 'hod_engine' THEN 'Chief Engineer'
          WHEN 'hod_interior' THEN 'Chief Stewardess'
          WHEN 'hod_galley' THEN 'Chef'
          WHEN 'deck' THEN 'Deckhand'
          WHEN 'engine' THEN 'Motorman'
          WHEN 'interior' THEN 'Stewardess'
          WHEN 'galley' THEN 'Cook'
          ELSE 'Crew'
        END,
        CASE
          WHEN u.access_position IN
            ('master','hod_deck','hod_engine','hod_interior','hod_galley')
          THEN 1 ELSE 5
        END,
        u.id,
        true
      FROM users u
      WHERE u.role = 'user'
        AND u.ship_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM crew_members cm WHERE cm.user_id = u.id
        )
    `);
  }

  public async down(): Promise<void> {
    // Data repair — nothing to revert.
  }
}
