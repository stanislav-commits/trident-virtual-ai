// Shared PMS task types + pure schedule helpers, used by the Tasks table
// (PmsSection) and the task detail drawer. Extracted from PmsSection so the
// god-file shrinks instead of growing (see CLAUDE.md).

export type PmsStatus = "overdue" | "due-soon" | "ok";
export type PmsPriority = "low" | "medium" | "high" | "critical";
export type PmsPlanning = "planned" | "unplanned";
export type IntervalUnit = "days" | "weeks" | "months" | "years";

/** Which board a task lives on. */
export type PmsBoard = "maintenance" | "general";

/** Maintenance Plan — equipment upkeep tied to assets. */
export const CATEGORIES = [
  "Inspection",
  "Service",
  "Replacement",
  "Overhaul",
  "Lubrication",
  "Test",
  "Cleaning",
  "Calibration",
  "Survey",
  "Repair",
  "Other",
] as const;

/** Tasks board — people-directed work (certificates, drills, assignments). */
export const GENERAL_CATEGORIES = [
  "Certificate",
  "Survey",
  "Drill",
  "Assignment",
  "Inspection",
  "Training",
  "Other",
] as const;

export type PmsCategory =
  | (typeof CATEGORIES)[number]
  | (typeof GENERAL_CATEGORIES)[number];

export interface LinkedAsset {
  id: string;
  name: string;
}

export interface PmsTask {
  id: string;
  task: string;
  category: PmsCategory;
  planning: PmsPlanning;
  // System-managed marker; "hours_reminder" = auto monthly hours-reading task.
  source?: string;
  // 'maintenance' (asset upkeep) | 'general' (certificates/drills/assignments).
  board?: string;
  // engine | bridge | ratings | "" (general) — drives rank-based visibility.
  department?: string;
  description?: string;
  assets: LinkedAsset[];
  sfiGroup?: string;
  sfiGroupName?: string;
  assigneeId?: string;
  assigneeName?: string;
  responsibleRole?: string;
  priority: PmsPriority;
  // Calendar schedule.
  dueDate: string | null;
  startDate: string | null;
  repeatDate: boolean;
  intervalValue: number | null;
  intervalUnit: IntervalUnit;
  // Running-hours schedule (current hours come from the asset's metric).
  intervalHours: number | null;
  startHours: number | null;
  currentHours: number | null;
  dueHours: number | null;
  lastDoneHours: number | null;
  lastDone: string | null;
  // Computed.
  status: PmsStatus;
  due: string;
  completedAt: string | null;
  completedByName: string | null;
  completedByPosition: string | null;
  completionNotes: string | null;
}

export const STATUS_LABEL: Record<PmsStatus, string> = {
  overdue: "Overdue",
  "due-soon": "Due soon",
  ok: "OK",
};

export const STATUS_ORDER: Record<PmsStatus, number> = {
  overdue: 0,
  "due-soon": 1,
  ok: 2,
};

export const PRIORITY_LABEL: Record<PmsPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const INTERVAL_UNITS: IntervalUnit[] = [
  "days",
  "weeks",
  "months",
  "years",
];

/** Windows within which a task still counts as "due soon". */
export const HOURS_SOON_WINDOW = 20;
export const DAYS_SOON_WINDOW = 10;

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

export type DueHorizon = "overdue" | "week" | "month" | "later" | "none";
export function dueHorizon(t: { dueDate: string | null }): DueHorizon {
  if (!t.dueDate) return "none";
  const days = daysUntil(t.dueDate);
  if (days < 0) return "overdue";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  return "later";
}

export function addInterval(
  iso: string,
  value: number,
  unit: IntervalUnit,
): string {
  const d = new Date(`${iso}T00:00:00`);
  if (unit === "days") d.setDate(d.getDate() + value);
  else if (unit === "weeks") d.setDate(d.getDate() + value * 7);
  else if (unit === "months") d.setMonth(d.getMonth() + value);
  else if (unit === "years") d.setFullYear(d.getFullYear() + value);
  return d.toISOString().slice(0, 10);
}

/** Next service mark strictly after `current`, aligned to interval multiples. */
export function nextHoursMark(current: number, interval: number): number {
  return (Math.floor(current / interval) + 1) * interval;
}

export function intervalLabel(value: number, unit: IntervalUnit): string {
  return `${value} ${value === 1 ? unit.slice(0, -1) : unit}`;
}

export function deriveDue(dateStr: string): { status: PmsStatus; due: string } {
  const days = daysUntil(dateStr);
  const status: PmsStatus =
    days < 0 ? "overdue" : days <= DAYS_SOON_WINDOW ? "due-soon" : "ok";
  const due =
    days < 0
      ? `${-days} day${days === -1 ? "" : "s"} ago`
      : days === 0
        ? "today"
        : `in ${days} day${days === 1 ? "" : "s"}`;
  return { status, due };
}

export function deriveHours(
  current: number,
  due: number,
): { status: PmsStatus; due: string } {
  const left = Math.round(due - current);
  const status: PmsStatus =
    left < 0 ? "overdue" : left <= HOURS_SOON_WINDOW ? "due-soon" : "ok";
  const dueTxt =
    left < 0 ? `${-left} hrs over` : left === 0 ? "due now" : `${left} hrs left`;
  return { status, due: dueTxt };
}

export function isRecurring(t: PmsTask): boolean {
  return t.planning === "planned" && (t.repeatDate || t.intervalHours != null);
}

/**
 * A task's instructions as display lines. Imported checklists arrive as
 * "1. …\n2. …" — keep the numbering, one step per line; plain text stays
 * a single block.
 */
export function descriptionLines(description: string): string[] {
  return description
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Compact "every …" label combining calendar and hours intervals. */
export function repeatLabel(t: PmsTask): string | null {
  const cal =
    t.repeatDate && t.intervalValue != null
      ? `every ${intervalLabel(t.intervalValue, t.intervalUnit)}`
      : null;
  const hrs = t.intervalHours != null ? `${t.intervalHours} h` : null;
  if (cal && hrs) return `${cal} / ${hrs}`;
  if (cal) return cal;
  if (hrs) return `every ${hrs}`;
  return null;
}
