import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { formatError } from '../../../common/utils/error.utils';
import type { OverviewCard, OverviewStat } from '../overview.types';

/** Days ahead that count as "due soon" on this card. */
const DUE_SOON_DAYS = 30;

/**
 * Imported completion-history rows share their parent task's external_ref and
 * exist only as a log of past work — counting them as open work would triple
 * the board. Legacy `alert` rows are filtered everywhere in the PMS (see
 * PmsService.isNotAlertTask) so alarms stay in the alerts panel.
 */
const HISTORY_SOURCE = 'import-history';
const ALERT_SOURCE = 'alert';

interface MaintenanceCountsRow {
  open_count: string;
  overdue_count: string;
  due_soon_count: string;
  no_schedule_count: string;
  postponed_count: string;
  completed_count: string;
  /** "No schedule" rows that do carry a running-hours interval. */
  hours_interval_count: string;
  /** Rows with an explicit due_hours mark — the hours leg we cannot evaluate. */
  due_hours_count: string;
  /** History rows with no completed_at: in neither the open nor the done figure. */
  open_history_count: string;
  total_count: string;
}

/**
 * ONE statement, because the point of this section is that the browser stops
 * counting rows. FILTER lets every stat share a single sequential scan of the
 * vessel's tasks.
 *
 * Only the calendar leg is evaluated. The board's real status is worst-of
 * (calendar, running hours) and the hours leg needs a live Influx reading per
 * asset, which an aggregator must never do — so the hours-shaped columns below
 * exist to MEASURE the blind spot and report it in `notes`, not to fill it.
 */
const COUNTS_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE open)                                    AS open_count,
    COUNT(*) FILTER (WHERE open AND effective_due < CURRENT_DATE)   AS overdue_count,
    COUNT(*) FILTER (
      WHERE open
        AND effective_due >= CURRENT_DATE
        AND effective_due <= CURRENT_DATE + $2::int
    )                                                               AS due_soon_count,
    COUNT(*) FILTER (WHERE open AND unscheduled)                    AS no_schedule_count,
    COUNT(*) FILTER (WHERE open AND postpone_count > 0)             AS postponed_count,
    COUNT(*) FILTER (WHERE completed_at IS NOT NULL)                AS completed_count,
    COUNT(*) FILTER (
      WHERE open AND unscheduled AND interval_hours IS NOT NULL
    )                                                               AS hours_interval_count,
    COUNT(*) FILTER (WHERE due_hours IS NOT NULL)                   AS due_hours_count,
    COUNT(*) FILTER (
      WHERE completed_at IS NULL AND source = $4
    )                                                               AS open_history_count,
    COUNT(*)                                                        AS total_count
  FROM (
    SELECT
      completed_at,
      due_date,
      due_hours,
      interval_hours,
      postpone_count,
      source,
      completed_at IS NULL AND source <> $4                AS open,
      -- The board anchors an undated task to its start date (pms.service.ts
      -- effectiveDueDate), so a task with only a start_date is overdue there.
      -- Reading due_date alone made this tile disagree with the board it links
      -- to, and with the Tasks card beside it, which already coalesces.
      COALESCE(due_date, start_date)                       AS effective_due,
      -- Hours schedules are derived, not stored: due_hours OR an interval with
      -- a baseline to count from. Ignoring the derived form parked genuinely
      -- scheduled tasks under "no schedule" the moment hours baselines exist.
      due_date IS NULL
        AND start_date IS NULL
        AND due_hours IS NULL
        AND (
          interval_hours IS NULL
          OR COALESCE(last_done_hours, start_hours) IS NULL
        )                                                  AS unscheduled
    FROM pms_tasks
    WHERE ship_id = $1::uuid
      AND board = 'maintenance'
      AND source <> $3
  ) t
`;

const toCount = (value: string | number | null): number => Number(value ?? 0);

@Injectable()
export class MaintenanceAggregator {
  private readonly logger = new Logger(MaintenanceAggregator.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async collect(shipId: string): Promise<OverviewCard> {
    try {
      const rows = (await this.dataSource.query(COUNTS_SQL, [
        shipId,
        DUE_SOON_DAYS,
        ALERT_SOURCE,
        HISTORY_SOURCE,
      ])) as MaintenanceCountsRow[];
      return this.buildCard(rows[0]);
    } catch (error) {
      this.logger.error(
        `Maintenance overview failed for ship ${shipId}: ${formatError(error)}`,
      );
      return {
        key: 'maintenance',
        title: 'Maintenance plan',
        headline: null,
        headlineLabel: 'open tasks',
        stats: [],
        notes: ['The maintenance plan could not be read from the database.'],
        section: 'maintenance',
        degraded: {
          reason: 'The maintenance aggregate could not be read.',
          affects: [
            'open',
            'overdue',
            'due soon',
            'no schedule',
            'completed',
            'postponed',
          ],
        },
      };
    }
  }

  private buildCard(row: MaintenanceCountsRow | undefined): OverviewCard {
    const total = toCount(row?.total_count ?? 0);
    const open = toCount(row?.open_count ?? 0);
    const overdue = toCount(row?.overdue_count ?? 0);
    const dueSoon = toCount(row?.due_soon_count ?? 0);
    const noSchedule = toCount(row?.no_schedule_count ?? 0);
    const postponed = toCount(row?.postponed_count ?? 0);
    const completed = toCount(row?.completed_count ?? 0);
    const hoursInterval = toCount(row?.hours_interval_count ?? 0);
    const dueHours = toCount(row?.due_hours_count ?? 0);
    const openHistory = toCount(row?.open_history_count ?? 0);

    const stats: OverviewStat[] = [
      {
        label: 'Overdue',
        value: overdue,
        tone: overdue > 0 ? 'bad' : 'good',
        hint: 'by due date, or start date when no due date is set; running-hours schedules are not evaluated',
      },
      {
        label: `Due in ${DUE_SOON_DAYS} days`,
        value: dueSoon,
        tone: dueSoon > 0 ? 'warn' : 'neutral',
        hint: 'excludes tasks already overdue and any running-hours schedule',
      },
      {
        label: 'No schedule',
        value: noSchedule,
        tone: noSchedule > 0 ? 'warn' : 'neutral',
        hint: 'no due date, no start date, and no running-hours mark it could be measured against',
      },
      {
        label: 'Postponed',
        value: postponed,
        tone: postponed > 0 ? 'warn' : 'neutral',
        hint: 'open tasks pushed at least once; the counter resets on completion, so this is not a lifetime total',
      },
      {
        label: 'Completed',
        value: completed,
        tone: 'neutral',
        hint: `context only — includes imported '${HISTORY_SOURCE}' rows, which are excluded from every open figure above`,
      },
    ];

    return {
      key: 'maintenance',
      title: 'Maintenance plan',
      headline: total === 0 ? null : open,
      headlineLabel: 'open tasks',
      stats,
      notes: this.buildNotes({
        total,
        dueHours,
        hoursInterval,
        openHistory,
      }),
      section: 'maintenance',
    };
  }

  private buildNotes(input: {
    total: number;
    dueHours: number;
    hoursInterval: number;
    openHistory: number;
  }): string[] {
    if (input.total === 0) {
      return ['No maintenance tasks exist for this vessel yet.'];
    }
    const notes = [
      'Calendar leg only. A task is overdue on the board when EITHER its due date or its running-hours mark has passed; the hours leg needs a live reading per asset and is not evaluated here, so the real overdue count can only be higher.',
      `Imported completion history (source '${HISTORY_SOURCE}') is excluded from the open, overdue, due-soon, no-schedule and postponed figures, and alert-spawned tasks are excluded from all of them.`,
    ];
    notes.push(
      input.dueHours === 0
        ? 'No task on this vessel has a due_hours mark set, so the running-hours leg currently excludes nothing — but it will the moment one is entered.'
        : `${input.dueHours} task(s) carry a due_hours mark that this card does not evaluate.`,
    );
    if (input.hoursInterval > 0) {
      notes.push(
        `${input.hoursInterval} of the "no schedule" tasks carry a running-hours interval with nothing to count it from (no last-done or start hours), which is why they still count as unscheduled.`,
      );
    }
    if (input.openHistory > 0) {
      notes.push(
        `${input.openHistory} imported history row(s) have no completion date and so appear in neither the open nor the completed figure.`,
      );
    }
    return notes;
  }
}
