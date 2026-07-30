import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { formatError } from '../../../common/utils/error.utils';
import type { OverviewCard, OverviewStat } from '../overview.types';

/** Days ahead that count as "due soon" on this card. */
const DUE_SOON_DAYS = 30;

/**
 * Alert-spawned tasks are filtered out everywhere in the PMS (see
 * PmsService.isNotAlertTask) so alarms stay in the alerts panel.
 */
const ALERT_SOURCE = 'alert';
/**
 * Imported completion history rides on the maintenance board today only because
 * `commitHistory` never sets `board` and the column defaults to it. Every other
 * PMS reader excludes both sources, so this one does too rather than relying on
 * that default holding.
 */
const HISTORY_SOURCE = 'import-history';

/** Compliance-driven tasks: the same real-world item as a compliance doc. */
const COMPLIANCE_SOURCE = 'compliance';

/** Departments listed individually before the rest is folded away. */
const MAX_DEPARTMENT_STATS = 3;

interface DepartmentRow {
  department: string;
  open: number;
}

interface TasksCountsRow {
  total_count: string;
  open_count: string;
  completed_count: string;
  overdue_count: string;
  due_soon_count: string;
  unassigned_count: string;
  /** Open + unassigned rows that do name a responsible role as free text. */
  role_only_count: string;
  undated_count: string;
  /** Open rows whose calendar reference comes from start_date, not due_date. */
  start_date_fallback_count: string;
  /** The running-hours leg this card cannot evaluate. */
  due_hours_count: string;
  compliance_count: string;
  /** Rows with no board at all — the schema forbids it, so this proves it. */
  board_missing_count: string;
  /** …of which this card claims (no asset link ⇒ not equipment upkeep). */
  board_missing_claimed_count: string;
  departments: DepartmentRow[] | null;
}

interface DefectCountsRow {
  open_count: string;
  total_count: string;
}

type DefectCounts =
  | { ok: true; open: number; total: number }
  | { ok: false; error: string };

/**
 * ONE statement, because the point of this section is that the browser stops
 * counting rows: every stat shares a single scan of the vessel's tasks.
 *
 * The general board is `board = 'general'`. The null-board leg is deliberate
 * defence, not live logic: `board` is NOT NULL DEFAULT 'maintenance' since
 * migration 20260717000200 and prod holds zero null rows, but the DTO layer
 * still lets a null through (PmsService maps `board ?? 'maintenance'`), and a
 * row that reached the table with no board must land on exactly one card
 * rather than vanish from both. Absent an asset link it is not equipment
 * upkeep, so it belongs here; `board_missing_*` measures whether that ever
 * fires so `notes` can say so instead of guessing.
 *
 * Only the calendar leg is evaluated. A task's real status is worst-of
 * (calendar, running hours) and the hours leg needs a live reading per asset,
 * which an aggregator must never fetch — so `due_hours_count` exists to
 * MEASURE that blind spot for `notes`, not to fill it.
 */
const COUNTS_SQL = `
  WITH scoped AS MATERIALIZED (
    SELECT
      t.completed_at IS NULL                                    AS is_open,
      t.board = 'general'
        OR (
          t.board IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM pms_task_assets l WHERE l.task_id = t.id
          )
        )                                                       AS is_general,
      t.board IS NULL                                           AS board_missing,
      COALESCE(t.due_date, t.start_date)                        AS eff_due,
      t.due_date,
      t.start_date,
      t.due_hours,
      t.assignee_user_id,
      t.responsible_role,
      t.department,
      t.source
    FROM pms_tasks t
    WHERE t.ship_id = $1::uuid
      AND t.source NOT IN ($2, $3)
  ),
  counts AS (
    SELECT
      COUNT(*) FILTER (WHERE is_general)                         AS total_count,
      COUNT(*) FILTER (WHERE is_general AND is_open)             AS open_count,
      COUNT(*) FILTER (WHERE is_general AND NOT is_open)         AS completed_count,
      COUNT(*) FILTER (
        WHERE is_general AND is_open AND eff_due < CURRENT_DATE
      )                                                         AS overdue_count,
      COUNT(*) FILTER (
        WHERE is_general
          AND is_open
          AND eff_due >= CURRENT_DATE
          AND eff_due <= CURRENT_DATE + $4::int
      )                                                         AS due_soon_count,
      COUNT(*) FILTER (
        WHERE is_general AND is_open AND assignee_user_id IS NULL
      )                                                         AS unassigned_count,
      COUNT(*) FILTER (
        WHERE is_general
          AND is_open
          AND assignee_user_id IS NULL
          AND COALESCE(responsible_role, '') <> ''
      )                                                         AS role_only_count,
      COUNT(*) FILTER (
        WHERE is_general AND is_open AND eff_due IS NULL
      )                                                         AS undated_count,
      COUNT(*) FILTER (
        WHERE is_general
          AND is_open
          AND due_date IS NULL
          AND start_date IS NOT NULL
      )                                                    AS start_date_fallback_count,
      COUNT(*) FILTER (
        WHERE is_general AND is_open AND due_hours IS NOT NULL
      )                                                         AS due_hours_count,
      COUNT(*) FILTER (
        WHERE is_general AND is_open AND source = $5
      )                                                         AS compliance_count,
      COUNT(*) FILTER (WHERE board_missing)                      AS board_missing_count,
      COUNT(*) FILTER (
        WHERE board_missing AND is_general
      )                                              AS board_missing_claimed_count
    FROM scoped
  ),
  departments AS (
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('department', d.department, 'open', d.open)
        ORDER BY d.open DESC, d.department
      ),
      '[]'::jsonb
    ) AS departments
    FROM (
      SELECT department, COUNT(*)::int AS open
      FROM scoped
      WHERE is_general AND is_open AND department IS NOT NULL
      GROUP BY department
    ) d
  )
  SELECT counts.*, departments.departments
  FROM counts CROSS JOIN departments
`;

/**
 * `status <> 'closed'` rather than `= 'open'`: the column is free varchar, so a
 * status nobody anticipated must read as still-open work, never disappear.
 */
const DEFECTS_SQL = `
  SELECT
    COUNT(*) FILTER (WHERE status <> 'closed')  AS open_count,
    COUNT(*)                                    AS total_count
  FROM defects
  WHERE ship_id = $1::uuid
`;

const toCount = (value: string | number | null | undefined): number =>
  Number(value ?? 0);

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

@Injectable()
export class TasksAggregator {
  private readonly logger = new Logger(TasksAggregator.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async collect(shipId: string): Promise<OverviewCard> {
    let row: TasksCountsRow | undefined;
    try {
      const rows = (await this.dataSource.query(COUNTS_SQL, [
        shipId,
        ALERT_SOURCE,
        HISTORY_SOURCE,
        DUE_SOON_DAYS,
        COMPLIANCE_SOURCE,
      ])) as TasksCountsRow[];
      row = rows[0];
    } catch (error) {
      this.logger.error(
        `Tasks overview failed for ship ${shipId}: ${formatError(error)}`,
      );
      return {
        key: 'tasks',
        title: 'Tasks',
        headline: null,
        headlineLabel: 'open tasks',
        stats: [],
        notes: ['The Tasks board could not be read from the database.'],
        section: 'tasks',
        degraded: {
          reason: 'The tasks aggregate could not be read.',
          affects: [
            'open',
            'overdue',
            'due soon',
            'unassigned',
            'no due date',
            'by department',
            'open defects',
          ],
        },
      };
    }
    // Defects live in their own table and their own failure mode; keeping the
    // read separate means a missing or broken defect register costs one stat,
    // not the whole card.
    const defects = await this.collectDefects(shipId);
    return this.buildCard(row, defects);
  }

  private async collectDefects(shipId: string): Promise<DefectCounts> {
    try {
      const rows = (await this.dataSource.query(DEFECTS_SQL, [
        shipId,
      ])) as DefectCountsRow[];
      return {
        ok: true,
        open: toCount(rows[0]?.open_count),
        total: toCount(rows[0]?.total_count),
      };
    } catch (error) {
      this.logger.warn(
        `Defect count unavailable for ship ${shipId}: ${formatError(error)}`,
      );
      return { ok: false, error: formatError(error) };
    }
  }

  private buildCard(
    row: TasksCountsRow | undefined,
    defects: DefectCounts,
  ): OverviewCard {
    const total = toCount(row?.total_count);
    const open = toCount(row?.open_count);
    const completed = toCount(row?.completed_count);
    const overdue = toCount(row?.overdue_count);
    const dueSoon = toCount(row?.due_soon_count);
    const unassigned = toCount(row?.unassigned_count);
    const roleOnly = toCount(row?.role_only_count);
    const undated = toCount(row?.undated_count);
    const startDateFallback = toCount(row?.start_date_fallback_count);
    const dueHours = toCount(row?.due_hours_count);
    const compliance = toCount(row?.compliance_count);
    const boardMissing = toCount(row?.board_missing_count);
    const boardMissingClaimed = toCount(row?.board_missing_claimed_count);
    const departments = row?.departments ?? [];

    const stats: OverviewStat[] = [
      {
        label: 'Overdue',
        value: overdue,
        tone: overdue > 0 ? 'bad' : 'good',
        hint: 'by calendar date only; excludes completed tasks and any running-hours schedule',
      },
      {
        label: `Due in ${DUE_SOON_DAYS} days`,
        value: dueSoon,
        tone: dueSoon > 0 ? 'warn' : 'neutral',
        hint: `excludes tasks already overdue; the Tasks board's own "due soon" badge uses a shorter window, so the two counts will not match`,
      },
      {
        label: 'Unassigned',
        value: unassigned,
        tone: unassigned > 0 ? 'warn' : 'good',
        hint: 'no assignee_user_id; a free-text responsible role does not count as assigned',
      },
      {
        label: 'No due date',
        value: undated,
        tone: undated > 0 ? 'warn' : 'neutral',
        hint: 'neither a due date nor a start-date anchor, so these can never appear as overdue or due soon',
      },
    ];

    if (defects.ok) {
      stats.push({
        label: 'Open defects',
        value: defects.open,
        tone: defects.open > 0 ? 'bad' : 'neutral',
        hint: 'from the defect register, not this board; a zero can also mean nothing has been logged there yet',
      });
    }

    for (const dept of departments.slice(0, MAX_DEPARTMENT_STATS)) {
      stats.push({
        label: `Open — ${dept.department}`,
        value: dept.open,
        tone: 'neutral',
        hint: 'open tasks whose department is set to this value',
      });
    }

    return {
      key: 'tasks',
      title: 'Tasks',
      headline: total === 0 ? null : open,
      headlineLabel: 'open tasks',
      stats,
      notes: this.buildNotes({
        total,
        completed,
        compliance,
        roleOnly,
        startDateFallback,
        dueHours,
        boardMissing,
        boardMissingClaimed,
        departmentCount: departments.length,
        hiddenDepartments: Math.max(
          0,
          departments.length - MAX_DEPARTMENT_STATS,
        ),
        defects,
      }),
      section: 'tasks',
      ...(defects.ok
        ? {}
        : {
            degraded: {
              reason: 'The open-defect count could not be read.',
              affects: ['open defects'],
            },
          }),
    };
  }

  private buildNotes(input: {
    total: number;
    completed: number;
    compliance: number;
    roleOnly: number;
    startDateFallback: number;
    dueHours: number;
    boardMissing: number;
    boardMissingClaimed: number;
    departmentCount: number;
    hiddenDepartments: number;
    defects: DefectCounts;
  }): string[] {
    const notes: string[] = [];
    if (input.total === 0) {
      notes.push("No task exists on this vessel's general Tasks board yet.");
    }
    notes.push(
      'This is the general Tasks board only — people-directed work: certificate deadlines, surveys, drills, assignments. Equipment upkeep lives on the Maintenance card and is counted there, not here.',
    );
    notes.push(
      'A task has no status column: "open" means it has no completion date. Recurring tasks are reopened by clearing that date, so an open task may well have been done before.',
    );
    if (input.completed > 0) {
      notes.push(
        `Completed tasks are excluded from every figure above: ${input.completed} of the ${input.total} rows on this board carry a completion date.`,
      );
    }
    notes.push(
      input.startDateFallback > 0
        ? `Calendar reference is the due date, falling back to the start-date anchor; ${plural(
            input.startDateFallback,
            'open task relies',
            'open tasks rely',
          )} on that fallback.`
        : 'Calendar reference is the due date, falling back to the start-date anchor when no due date is set.',
    );
    notes.push(
      input.dueHours === 0
        ? 'The running-hours leg is not evaluated (it needs a live reading per asset). No open task on this board carries a due-hours mark today, so nothing is currently hidden by that — but it would be the moment one is entered.'
        : `${plural(
            input.dueHours,
            'open task carries',
            'open tasks carry',
          )} a due-hours mark that this card does not evaluate, so the real overdue count can only be higher.`,
    );
    if (input.compliance > 0) {
      notes.push(
        `${plural(
          input.compliance,
          'open task was',
          'open tasks were',
        )} generated from a compliance document, so an overdue task here is usually the same real-world item as an expired document on the Compliance card — do not add the two together.`,
      );
    }
    if (input.roleOnly > 0) {
      notes.push(
        `${plural(
          input.roleOnly,
          'unassigned task names',
          'unassigned tasks name',
        )} a responsible role as free text (imported wording, not a user account), so somebody may be nominally responsible without the task being assigned.`,
      );
    }
    if (input.departmentCount === 0 && input.total > 0) {
      notes.push(
        'No open task on this board has a department set, so there is no department breakdown. On this board an empty department is normal: it means the task is not department-gated and every crew member sees it.',
      );
    }
    if (input.hiddenDepartments > 0) {
      notes.push(
        `Only the ${MAX_DEPARTMENT_STATS} largest departments are listed; ${input.hiddenDepartments} more have open tasks.`,
      );
    }
    if (input.boardMissing > 0) {
      notes.push(
        `${plural(
          input.boardMissing,
          'task has',
          'tasks have',
        )} no board set at all, which the schema is supposed to forbid; ${
          input.boardMissingClaimed
        } of them (no asset link) are counted here and the rest appear on no card.`,
      );
    }
    notes.push(
      "Alert-spawned tasks and imported completion history are both excluded. Alerts always create their task on the maintenance board and history rows inherit it, so neither exclusion removes anything from this card today — they are here so a change of default cannot quietly inflate it.",
    );
    if (!input.defects.ok) {
      notes.push(
        'The defect register could not be read, so open defects are not shown.',
      );
    } else {
      notes.push(
        input.defects.total === 0
          ? 'The defect register holds no record for this vessel. Defects are only ever written by the chat flow and no screen reads them back yet, so zero means "nothing logged", not "nothing broken".'
          : `Open defects count the defect register (${input.defects.total} record(s) in total), which is separate from this board — a defect and the unplanned task it spawned are two rows describing one failure.`,
      );
    }
    return notes;
  }
}
