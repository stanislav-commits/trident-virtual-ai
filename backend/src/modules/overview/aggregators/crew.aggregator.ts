import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { OverviewCard, OverviewStatTone } from '../overview.types';

type CrewCountsRow = {
  total: number;
  active: number;
  active_with_login: number;
  active_without_login: number;
  departments: number;
};

/**
 * Crew tile of the admin Overview.
 *
 * Deliberately thin: the roster is the ONLY crew data the schema holds. There is
 * no sign-on/sign-off, contract or rotation model anywhere (crew_members.joined_at
 * has no leaving counterpart), so the strongest true statement is "active on the
 * roster" — every note below exists to stop an admin reading it as "on board".
 *
 * Certificate coverage (CoC, STCW, ENG1, flag endorsements) is NOT counted here
 * on purpose: PERSONNEL certificates hang off the compliance-document model
 * (compliance_docs with archetype 'PERSONNEL', linked per person through
 * doc_asset_links.crew_member_id), and that model is about to be reworked. On
 * production today zero documents carry that archetype, so any coverage number
 * would be both meaningless and short-lived.
 */
@Injectable()
export class CrewAggregator {
  private readonly logger = new Logger(CrewAggregator.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async collect(shipId: string): Promise<OverviewCard> {
    let row: CrewCountsRow | undefined;
    try {
      const rows: CrewCountsRow[] = await this.dataSource.query(
        `SELECT
           COUNT(*)::int AS total,
           (COUNT(*) FILTER (WHERE active))::int AS active,
           (COUNT(*) FILTER (WHERE active AND user_id IS NOT NULL))::int
             AS active_with_login,
           (COUNT(*) FILTER (WHERE active AND user_id IS NULL))::int
             AS active_without_login,
           (COUNT(DISTINCT department) FILTER (WHERE active))::int AS departments
         FROM crew_members
         WHERE ship_id = $1`,
        [shipId],
      );
      row = rows[0];
    } catch (error) {
      this.logger.warn(
        `Crew overview aggregation failed for ship ${shipId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.degradedCard();
    }

    if (!row) return this.degradedCard();

    const total = Number(row.total);
    const active = Number(row.active);
    const withLogin = Number(row.active_with_login);
    const withoutLogin = Number(row.active_without_login);
    const departments = Number(row.departments);
    const inactive = total - active;

    const notes = [
      "'Active' means crew_members.active on the roster. The schema has no sign-on/sign-off, contract or rotation model — joined_at is the only date on a crew row and has no leaving counterpart — so nothing here says who is physically on board.",
      'Crew certificates (CoC, STCW, ENG1, flag endorsements) are not counted yet: they live on the compliance-document model, which is being reworked, and would have to be re-derived afterwards.',
      'Only roster rows are counted. A platform login with no crew_members row — admins, and any vessel account created outside the roster — is invisible on this tile.',
    ];
    if (inactive > 0) {
      notes.push(
        `${inactive} roster ${inactive === 1 ? 'row is' : 'rows are'} marked inactive and excluded from every number above.`,
      );
    }
    if (total === 0) {
      notes.push('No crew roster exists for this vessel yet.');
    }

    return {
      key: 'crew',
      title: 'Crew',
      // Null, not 0, when the roster is empty: 0 active out of 12 rows is a
      // problem to fix, an absent roster is a section nobody has filled in.
      headline: total === 0 ? null : active,
      headlineLabel: 'active crew',
      stats: [
        {
          label: 'With platform login',
          value: withLogin,
          tone: this.tone(withLogin > 0, 'good'),
          hint: 'Active roster rows linked to a users row. Excludes inactive rows, and admin accounts that are not on the roster.',
        },
        {
          label: 'Without platform login',
          value: withoutLogin,
          tone: this.tone(withoutLogin > 0, 'warn'),
          hint: 'On the roster but cannot sign in, be assigned a PMS task, or acknowledge an alert. Excludes inactive rows.',
        },
        // Certificate stats (valid / expiring / missing per person) attach here,
        // after the compliance-document rework gives PERSONNEL docs a stable
        // shape — one extra join from doc_asset_links.crew_member_id.
        {
          label: 'Departments represented',
          value: departments,
          tone: 'neutral',
          hint: "Distinct crew_members.department values among active rows. Counts the 'other' fallback bucket as a department, and legacy values ('bridge', 'ratings') that are no longer in the rank catalog.",
        },
      ],
      notes,
      section: 'crew',
    };
  }

  private tone(
    flagged: boolean,
    whenFlagged: OverviewStatTone,
  ): OverviewStatTone {
    return flagged ? whenFlagged : 'neutral';
  }

  private degradedCard(): OverviewCard {
    return {
      key: 'crew',
      title: 'Crew',
      headline: null,
      headlineLabel: 'active crew',
      stats: [],
      notes: [],
      section: 'crew',
      degraded: {
        reason: 'Crew roster count could not be read.',
        affects: [
          'active crew',
          'platform logins',
          'departments represented',
        ],
      },
    };
  }
}
