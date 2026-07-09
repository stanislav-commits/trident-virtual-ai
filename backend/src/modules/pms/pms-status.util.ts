import { PmsTaskEntity } from './entities/pms-task.entity';

/**
 * Pure PMS status derivation — NO NestJS / repository deps — so it can be
 * reused outside the PmsModule (e.g. the metrics analyzer reading the live
 * Tasks register directly) without importing the module and creating a DI
 * cycle. Mirrors the logic in PmsService (deriveTask/deriveDue/deriveHours +
 * the dueHours/effectiveDueDate computation in toDto).
 */
export type PmsTaskStatus = 'overdue' | 'due-soon' | 'ok';

export const PMS_HOURS_SOON_WINDOW = 20; // hrs before due that still count as due-soon
export const PMS_DAYS_SOON_WINDOW = 10;

/** Effective next-due running-hours mark from the task's stored fields. */
export function computeTaskDueHours(task: PmsTaskEntity): number | null {
  const lastDoneHours =
    task.lastDoneHours != null ? Number(task.lastDoneHours) : null;
  const startHours = task.startHours != null ? Number(task.startHours) : null;
  const hoursBaseline = lastDoneHours ?? startHours;
  if (task.dueHours != null) {
    return Number(task.dueHours);
  }
  if (task.intervalHours != null && hoursBaseline != null) {
    return hoursBaseline + task.intervalHours;
  }
  return null;
}

/** Calendar reference: explicit due date, else the start-date anchor. */
export function effectiveDueDate(task: PmsTaskEntity): string | null {
  return task.dueDate ?? task.startDate;
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.round((d.getTime() - today.getTime()) / 86_400_000);
}

function deriveDue(days: number): { status: PmsTaskStatus; due: string } {
  const status: PmsTaskStatus =
    days < 0 ? 'overdue' : days <= PMS_DAYS_SOON_WINDOW ? 'due-soon' : 'ok';
  const due =
    days < 0
      ? `${-days} day${days === -1 ? '' : 's'} ago`
      : days === 0
        ? 'today'
        : `in ${days} day${days === 1 ? '' : 's'}`;
  return { status, due };
}

function deriveHours(left: number): { status: PmsTaskStatus; due: string } {
  const status: PmsTaskStatus =
    left < 0 ? 'overdue' : left <= PMS_HOURS_SOON_WINDOW ? 'due-soon' : 'ok';
  const due =
    left < 0 ? `${-left} hrs over` : left === 0 ? 'due now' : `${left} hrs left`;
  return { status, due };
}

/**
 * Worst-of (calendar, hours) status + human "due" string. currentHours may be
 * null (calendar-only evaluation) — callers without a live running-hours
 * reading still get a correct calendar verdict.
 */
export function derivePmsStatus(input: {
  dueDate: string | null;
  currentHours: number | null;
  dueHours: number | null;
}): { status: PmsTaskStatus; due: string } {
  const parts: { status: PmsTaskStatus; due: string; rank: number }[] = [];
  if (input.dueDate) {
    const days = daysUntil(input.dueDate);
    parts.push({ ...deriveDue(days), rank: days });
  }
  if (input.currentHours != null && input.dueHours != null) {
    const left = Math.round(input.dueHours - input.currentHours);
    parts.push({ ...deriveHours(left), rank: left });
  }
  if (!parts.length) {
    return { status: 'ok', due: '—' };
  }
  const order: Record<PmsTaskStatus, number> = {
    overdue: 0,
    'due-soon': 1,
    ok: 2,
  };
  parts.sort((a, b) => order[a.status] - order[b.status] || a.rank - b.rank);
  return { status: parts[0].status, due: parts[0].due };
}
