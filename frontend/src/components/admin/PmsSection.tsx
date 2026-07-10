import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { PlusIcon, XIcon, RefreshIcon, TrashIcon, UploadIcon } from "./AdminPanelIcons";
import { fetchSfiGroups, type SfiNode } from "../../api/sfiApi";
import { listAssets, type AssetItem } from "../../api/assetsApi";
import { useAccessSchema } from "../../hooks/useAccessSchema";
import {
  listPmsTasks,
  createPmsTask,
  updatePmsTask,
  completePmsTask,
  deletePmsTask,
  previewPmsImport,
  commitPmsImport,
  type UpsertPmsTaskInput,
  type PmsImportPreview,
  type PmsImportDraft,
  type PmsImportMode,
} from "../../api/pmsApi";
import {
  listInventory,
  listTaskInventory,
  setTaskParts,
  type InventoryItem,
} from "../../api/inventoryApi";
import { useAdminShip } from "../../context/AdminShipContext";

interface PmsSectionProps {
  token: string | null;
}

type PmsStatus = "overdue" | "due-soon" | "ok";
type PmsPriority = "low" | "medium" | "high" | "critical";
type PmsPlanning = "planned" | "unplanned";
type IntervalUnit = "days" | "weeks" | "months" | "years";

const CATEGORIES = [
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
type PmsCategory = (typeof CATEGORIES)[number];

interface LinkedAsset {
  id: string;
  name: string;
}

interface PmsTask {
  id: string;
  task: string;
  category: PmsCategory;
  planning: PmsPlanning;
  // System-managed marker; "hours_reminder" = auto monthly hours-reading task.
  source?: string;
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
}

const STATUS_LABEL: Record<PmsStatus, string> = {
  overdue: "Overdue",
  "due-soon": "Due soon",
  ok: "OK",
};

const STATUS_ORDER: Record<PmsStatus, number> = {
  overdue: 0,
  "due-soon": 1,
  ok: 2,
};

const PRIORITY_LABEL: Record<PmsPriority, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

const INTERVAL_UNITS: IntervalUnit[] = ["days", "weeks", "months", "years"];

// Departments come from the shared access taxonomy (useAccessSchema) — see the
// component body. "" = general/all crew.

/** Windows within which a task still counts as "due soon". */
const HOURS_SOON_WINDOW = 20;
const DAYS_SOON_WINDOW = 10;


function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(`${dateStr}T00:00:00`);
  return Math.round((d.getTime() - today.getTime()) / 86400000);
}

type DueHorizon = "overdue" | "week" | "month" | "later" | "none";
function dueHorizon(t: { dueDate: string | null }): DueHorizon {
  if (!t.dueDate) return "none";
  const days = daysUntil(t.dueDate);
  if (days < 0) return "overdue";
  if (days <= 7) return "week";
  if (days <= 30) return "month";
  return "later";
}

/**
 * Column-header filter: the label stays fixed (never shows the picked value);
 * an invisible native <select> overlays it, and the header just highlights
 * when a filter is active.
 */
function HeaderFilter({
  label,
  value,
  active,
  options,
  onChange,
}: {
  label: string;
  value: string;
  active: boolean;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <span className={`pms__hf${active ? " pms__hf--active" : ""}`}>
      {label}
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <select
        className="pms__hf-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`Filter by ${label}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </span>
  );
}

function addInterval(iso: string, value: number, unit: IntervalUnit): string {
  const d = new Date(`${iso}T00:00:00`);
  if (unit === "days") d.setDate(d.getDate() + value);
  else if (unit === "weeks") d.setDate(d.getDate() + value * 7);
  else if (unit === "months") d.setMonth(d.getMonth() + value);
  else if (unit === "years") d.setFullYear(d.getFullYear() + value);
  return d.toISOString().slice(0, 10);
}

/** Next service mark strictly after `current`, aligned to interval multiples. */
function nextHoursMark(current: number, interval: number): number {
  return (Math.floor(current / interval) + 1) * interval;
}

function intervalLabel(value: number, unit: IntervalUnit): string {
  return `${value} ${value === 1 ? unit.slice(0, -1) : unit}`;
}

function deriveDue(dateStr: string): { status: PmsStatus; due: string } {
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

function deriveHours(
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

function isRecurring(t: PmsTask): boolean {
  return t.planning === "planned" && (t.repeatDate || t.intervalHours != null);
}

const EMPTY_FORM = {
  task: "",
  category: "Service" as PmsCategory,
  priority: "medium" as PmsPriority,
  planning: "planned" as PmsPlanning,
  department: "",
  sfiGroup: "",
  assigneeId: "",
  responsibleRole: "",
  dueDate: "",
  startDate: "",
  intervalValue: "",
  intervalUnit: "months" as IntervalUnit,
  intervalHours: "",
  startHours: "",
  dueHours: "",
  description: "",
};

type PmsForm = typeof EMPTY_FORM;

function formFromTask(t: PmsTask): PmsForm {
  return {
    task: t.task,
    category: t.category,
    priority: t.priority,
    planning: t.planning,
    department: t.department ?? "",
    sfiGroup: t.sfiGroup ?? "",
    assigneeId: t.assigneeId ?? "",
    responsibleRole: t.responsibleRole ?? "",
    dueDate: t.dueDate ?? "",
    startDate: t.startDate ?? "",
    intervalValue: t.intervalValue != null ? String(t.intervalValue) : "",
    intervalUnit: t.intervalUnit,
    intervalHours: t.intervalHours != null ? String(t.intervalHours) : "",
    startHours: t.startHours != null ? String(t.startHours) : "",
    dueHours: t.dueHours != null ? String(t.dueHours) : "",
    description: t.description ?? "",
  };
}

/** Searchable multi-select bound to the ship's asset register. */
function AssetMultiPicker({
  token,
  shipId,
  selected,
  onChange,
}: {
  token: string | null;
  shipId: string | null;
  selected: LinkedAsset[];
  onChange: (next: LinkedAsset[]) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!token || !shipId || !focused) return;
    let alive = true;
    setLoading(true);
    const h = setTimeout(async () => {
      try {
        const r = await listAssets(token, shipId, {
          search: q.trim() || undefined,
          limit: 20,
        });
        if (alive) setResults(r.items);
      } catch {
        if (alive) setResults([]);
      } finally {
        if (alive) setLoading(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [q, token, shipId, focused]);

  const add = (a: AssetItem) => {
    if (!selected.some((s) => s.id === a.id))
      onChange([...selected, { id: a.id, name: a.displayName }]);
    setQ("");
  };
  const remove = (id: string) => onChange(selected.filter((s) => s.id !== id));

  const available = results.filter((a) => !selected.some((s) => s.id === a.id));

  return (
    <div>
      {selected.length > 0 && (
        <div className="pms__chips-sel">
          {selected.map((s) => (
            <span key={s.id} className="pms__chip-sel">
              {s.name}
              <span
                className="pms__chip-x"
                role="button"
                aria-label={`Remove ${s.name}`}
                onClick={() => remove(s.id)}
              >
                ✕
              </span>
            </span>
          ))}
        </div>
      )}
      <input
        type="search"
        className="admin-panel__input admin-panel__input--full"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => setFocused(true)}
        placeholder={
          shipId ? "Search the asset register…" : "Select an active vessel first"
        }
        disabled={!shipId}
      />
      {focused && (
        <div className="pms__picker-results">
          {loading && <div className="pms__picker-empty">Searching…</div>}
          {!loading && available.length === 0 && (
            <div className="pms__picker-empty">
              {q.trim()
                ? "No assets match."
                : "No assets yet — import the register first."}
            </div>
          )}
          {!loading &&
            available.slice(0, 8).map((a) => (
              <div
                key={a.id}
                className="pms__picker-item"
                role="button"
                onClick={() => add(a)}
              >
                {a.displayName}
                {a.assetIdInternal ? (
                  <span className="pms__code"> {a.assetIdInternal}</span>
                ) : null}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/**
 * Searchable linked-parts picker for a task (same UX as the asset picker):
 * chips for attached parts + a popup with a search box and checkmark results.
 * Filters the ship's inventory client-side (parts are bounded per vessel).
 */
function TaskPartsPicker({
  all,
  value,
  onChange,
}: {
  all: InventoryItem[];
  value: InventoryItem[];
  onChange: (next: InventoryItem[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const selectedIds = new Set(value.map((p) => p.id));

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const q = query.trim().toLowerCase();
  const results = (
    q
      ? all.filter((p) =>
          [p.name, p.partNumber, p.manufacturer, p.category]
            .filter(Boolean)
            .some((v) => (v as string).toLowerCase().includes(q)),
        )
      : all
  ).slice(0, 40);

  const toggle = (p: InventoryItem) => {
    if (selectedIds.has(p.id)) onChange(value.filter((v) => v.id !== p.id));
    else onChange([...value, p]);
  };

  return (
    <div className="inv__picker" ref={boxRef}>
      {value.length > 0 && (
        <div className="inv__chips">
          {value.map((p) => (
            <span key={p.id} className="inv__chip">
              {p.name}
              {p.partNumber ? (
                <span className="inv__mono inv__muted"> {p.partNumber}</span>
              ) : null}
              <button
                type="button"
                className="inv__chip-x"
                onClick={() => onChange(value.filter((v) => v.id !== p.id))}
                aria-label={`Unlink ${p.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <button
        type="button"
        className="admin-panel__input inv__picker-trigger"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={value.length ? "" : "inv__muted"}>
          {value.length
            ? `${value.length} part${value.length === 1 ? "" : "s"} linked`
            : "— none —"}
        </span>
        <span className="inv__picker-caret">＋</span>
      </button>
      {open && (
        <div className="inv__picker-pop">
          <input
            type="search"
            className="admin-panel__input admin-panel__input--full"
            placeholder="Search part by name or number…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="inv__picker-list">
            {results.length === 0 && (
              <div className="inv__picker-hint">No matching parts</div>
            )}
            {results.map((p) => {
              const on = selectedIds.has(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`inv__picker-opt${on ? " inv__picker-opt--active" : ""}`}
                  onClick={() => toggle(p)}
                >
                  <span>
                    <input type="checkbox" checked={on} readOnly /> {p.name}
                  </span>
                  {p.partNumber ? (
                    <span className="inv__mono inv__muted">{p.partNumber}</span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function PmsSection({ token }: PmsSectionProps) {
  const { selectedShipId } = useAdminShip();
  const accessSchema = useAccessSchema();
  const DEPARTMENTS = useMemo(
    () => [
      { value: "", label: "General (all crew)" },
      ...(accessSchema?.departments.map((d) => ({
        value: d.key,
        label: d.label,
      })) ?? []),
    ],
    [accessSchema],
  );
  const deptLabel = (d?: string) =>
    DEPARTMENTS.find((x) => x.value === (d ?? ""))?.label ?? d;
  const [tasks, setTasks] = useState<PmsTask[]>([]);
  const [view, setView] = useState<"active" | "history">("active");
  const [statusFilter, setStatusFilter] = useState<PmsStatus | null>(null);
  const [categoryFilter] = useState<PmsCategory | "all">("all");
  // Per-column filters for the task table (all but Task).
  const [assetFilter, setAssetFilter] = useState<string>("all");
  const [personFilter, setPersonFilter] = useState<string>("all");
  const [dueFilter, setDueFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [form, setForm] = useState<PmsForm>({ ...EMPTY_FORM });
  const [assetDraft, setAssetDraft] = useState<LinkedAsset[]>([]);
  // Parts linked to the task being edited + the ship's full inventory (picker).
  const [taskParts, setTaskPartsState] = useState<InventoryItem[]>([]);
  const [allParts, setAllParts] = useState<InventoryItem[]>([]);
  const [sfiGroups, setSfiGroups] = useState<SfiNode[]>([]);
  const [importNote, setImportNote] = useState("");
  const [importPreview, setImportPreview] = useState<PmsImportPreview | null>(
    null,
  );
  const [importBusy, setImportBusy] = useState(false);
  // Which tab the import was launched from — active → task list, history → log.
  const [importMode, setImportMode] = useState<PmsImportMode>("tasks");
  const fileRef = useRef<HTMLInputElement>(null);

  const shipId = selectedShipId;

  useEffect(() => {
    if (!token) return;
    let alive = true;
    fetchSfiGroups(token)
      .then((g) => alive && setSfiGroups(g))
      .catch(() => alive && setSfiGroups([]));
    return () => {
      alive = false;
    };
  }, [token]);

  // Tasks come from the backend (pms_tasks), scoped to the active vessel.
  const refresh = useCallback(async () => {
    if (!token || !shipId) {
      setTasks([]);
      return;
    }
    try {
      setTasks((await listPmsTasks(token, shipId)) as unknown as PmsTask[]);
    } catch {
      setTasks([]);
    }
  }, [token, shipId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Map the form `fields` shape to the backend upsert input.
  const toUpsert = (f: {
    task: string;
    category: PmsCategory;
    planning: PmsPlanning;
    department?: string;
    description?: string;
    assets: LinkedAsset[];
    sfiGroup?: string;
    assigneeId?: string;
    responsibleRole?: string;
    priority: PmsPriority;
    dueDate: string | null;
    startDate: string | null;
    repeatDate: boolean;
    intervalValue: number | null;
    intervalUnit: IntervalUnit;
    intervalHours: number | null;
    startHours: number | null;
    dueHours: number | null;
  }): UpsertPmsTaskInput => ({
    task: f.task,
    category: f.category,
    planning: f.planning,
    department: f.department ? f.department : null,
    description: f.description ?? null,
    sfiGroup: f.sfiGroup ?? null,
    assigneeUserId: null,
    responsibleRole: f.responsibleRole ?? null,
    priority: f.priority,
    dueDate: f.dueDate,
    startDate: f.startDate,
    repeatDate: f.repeatDate,
    intervalValue: f.intervalValue,
    intervalUnit: f.intervalUnit,
    intervalHours: f.intervalHours,
    startHours: f.startHours,
    dueHours: f.dueHours,
    assetIds: f.assets.map((a) => a.id),
  });

  const active = useMemo(() => tasks.filter((t) => !t.completedAt), [tasks]);
  const history = useMemo(() => tasks.filter((t) => t.completedAt), [tasks]);

  // Distinct values for the per-column dropdowns.
  const columnFilterOpts = useMemo(() => {
    const assets = new Set<string>();
    const persons = new Set<string>();
    for (const t of tasks) {
      t.assets.forEach((a) => a.name && assets.add(a.name));
      const who = view === "history" ? t.completedByName : t.responsibleRole;
      if (who) persons.add(who);
    }
    return {
      assets: [...assets].sort((a, b) => a.localeCompare(b)),
      persons: [...persons].sort((a, b) => a.localeCompare(b)),
    };
  }, [tasks, view]);

  const visible = useMemo(() => {
    const base = view === "active" ? active : history;
    const q = search.trim().toLowerCase();
    return base
      .filter(
        (t) =>
          (view === "history" || !statusFilter || t.status === statusFilter) &&
          (categoryFilter === "all" || t.category === categoryFilter) &&
          (assetFilter === "all" ||
            t.assets.some((a) => a.name === assetFilter)) &&
          (personFilter === "all" ||
            (view === "history" ? t.completedByName : t.responsibleRole) ===
              personFilter) &&
          (dueFilter === "all" || dueHorizon(t) === dueFilter) &&
          (!q ||
            t.task.toLowerCase().includes(q) ||
            (t.responsibleRole ?? "").toLowerCase().includes(q) ||
            (t.completedByName ?? "").toLowerCase().includes(q) ||
            (t.sfiGroupName ?? "").toLowerCase().includes(q) ||
            t.assets.some((a) => a.name.toLowerCase().includes(q))),
      )
      .sort((a, b) =>
        view === "history"
          ? (b.completedAt ?? "").localeCompare(a.completedAt ?? "")
          : STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
      );
  }, [
    view,
    active,
    history,
    statusFilter,
    categoryFilter,
    assetFilter,
    personFilter,
    dueFilter,
    search,
  ]);

  const detailTask = useMemo(
    () => tasks.find((t) => t.id === detailId) ?? null,
    [tasks, detailId],
  );

  // Load the linked parts whenever a task detail is opened (read-only view).
  useEffect(() => {
    if (!detailId || !token || !selectedShipId) {
      if (!detailId) setTaskPartsState([]);
      return;
    }
    let alive = true;
    void listTaskInventory(token, selectedShipId, detailId)
      .then((p) => alive && setTaskPartsState(p))
      .catch(() => alive && setTaskPartsState([]));
    return () => {
      alive = false;
    };
  }, [detailId, token, selectedShipId]);

  const set =
    (key: keyof PmsForm) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const openCreate = () => {
    setForm({ ...EMPTY_FORM });
    setAssetDraft([]);
    setEditId(null);
    setShowForm(true);
    setTaskPartsState([]);
  };

  const startEdit = (t: PmsTask) => {
    setForm(formFromTask(t));
    setAssetDraft([...t.assets]);
    setEditId(t.id);
    setDetailId(null);
    setShowForm(true);
    setTaskPartsState([]);
    if (token && shipId) {
      void listTaskInventory(token, shipId, t.id)
        .then(setTaskPartsState)
        .catch(() => setTaskPartsState([]));
      void listInventory(token, shipId)
        .then(setAllParts)
        .catch(() => setAllParts([]));
    }
  };

  /** Persist the task's linked parts (only when editing an existing task). */
  const saveTaskParts = async (next: InventoryItem[]) => {
    setTaskPartsState(next);
    if (!token || !shipId || !editId) return;
    try {
      await setTaskParts(token, shipId, editId, next.map((p) => p.id));
    } catch {
      // reload truth on failure
      if (token && shipId)
        setTaskPartsState(await listTaskInventory(token, shipId, editId));
    }
  };

  const num = (s: string): number | null => {
    if (s === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const submitTask = (e: FormEvent) => {
    e.preventDefault();
    if (!form.task.trim()) return;

    const planned = form.planning === "planned";
    const grp = sfiGroups.find((g) => g.code === form.sfiGroup);

    let dueDate: string | null = null;
    let repeatDate = false;
    let intervalValue: number | null = null;
    let intervalHours: number | null = null;
    let dueHours: number | null = null;
    const startDate = form.startDate || null;
    const startHours = num(form.startHours);

    if (planned) {
      intervalValue = num(form.intervalValue);
      intervalHours = num(form.intervalHours);
      repeatDate = intervalValue != null;
      // Keep the existing next-due on edit; for a new task anchor on the
      // start-from date (schedule may begin in the future), else today.
      const base = startDate ?? todayIso();
      const existing = editId
        ? (tasks.find((t) => t.id === editId)?.dueDate ?? null)
        : null;
      dueDate =
        existing ??
        (intervalValue != null
          ? addInterval(base, intervalValue, form.intervalUnit)
          : startDate);
    } else {
      dueDate = form.dueDate || null;
      dueHours = num(form.dueHours);
    }

    const fields = {
      task: form.task.trim(),
      category: form.category,
      planning: form.planning,
      department: form.department,
      description: form.description.trim() || undefined,
      assets: [...assetDraft],
      sfiGroup: form.sfiGroup || undefined,
      sfiGroupName: grp?.name,
      responsibleRole: form.responsibleRole || undefined,
      priority: form.priority,
      dueDate,
      startDate,
      repeatDate,
      intervalValue,
      intervalUnit: form.intervalUnit,
      intervalHours,
      startHours,
      dueHours,
    };

    if (!token || !shipId) return;
    const input = toUpsert(fields);
    void (async () => {
      try {
        if (editId) {
          await updatePmsTask(token, shipId, editId, input);
        } else {
          await createPmsTask(token, shipId, input);
        }
        await refresh();
      } catch (e) {
        setImportNote(e instanceof Error ? e.message : "Failed to save task");
      }
    })();
    setForm({ ...EMPTY_FORM });
    setAssetDraft([]);
    setEditId(null);
    setShowForm(false);
  };

  const performTask = (id: string) => {
    if (!token || !shipId) return;
    const t = tasks.find((x) => x.id === id);
    void completePmsTask(token, shipId, id, {
      doneAtHours: t?.currentHours ?? undefined,
    })
      .then(refresh)
      .catch((e) =>
        setImportNote(
          e instanceof Error ? e.message : "Failed to complete task",
        ),
      );
  };

  const reopenTask = (id: string) => {
    if (!token || !shipId) return;
    // Reopening clears the completion: PATCH lastDoneAt back to null.
    void updatePmsTask(token, shipId, id, { completedAt: null })
      .then(refresh)
      .catch(() => undefined);
  };

  const deleteTask = (id: string) => {
    if (!token || !shipId) return;
    setDetailId((d) => (d === id ? null : d));
    void deletePmsTask(token, shipId, id)
      .then(refresh)
      .catch((e) =>
        setImportNote(e instanceof Error ? e.message : "Failed to delete task"),
      );
  };

  // ── Import (AI-mapped: PDF / XLSX / CSV / text) ───────────────────────
  const handleImportFile = async (file: File) => {
    if (!token || !shipId) return;
    const mode: PmsImportMode = view === "history" ? "history" : "tasks";
    setImportMode(mode);
    setImportBusy(true);
    setImportNote(`Reading & mapping “${file.name}” with AI…`);
    try {
      const preview = await previewPmsImport(token, shipId, file, mode);
      setImportPreview(preview);
      setImportNote(
        preview.drafts.length === 0
          ? "No records could be found in that file."
          : "",
      );
    } catch (e) {
      setImportPreview(null);
      setImportNote(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setImportBusy(false);
    }
  };

  const commitImport = async (drafts: PmsImportDraft[]) => {
    if (!token || !shipId) return;
    setImportBusy(true);
    try {
      const { created } = await commitPmsImport(token, shipId, drafts, importMode);
      setImportPreview(null);
      setImportNote(
        `Imported ${created} ${importMode === "history" ? "record" : "task"}${
          created === 1 ? "" : "s"
        }.`,
      );
      await refresh();
    } catch (e) {
      setImportNote(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setImportBusy(false);
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void handleImportFile(f);
    e.target.value = "";
  };

  return (
    <div className="pms">
      <div className="pms__header">
        <div>
          <h2 className="pms__title">Tasks</h2>
          <p className="pms__subtitle">
            Planned maintenance across the vessel — by date and/or running
            hours, linked to assets.
          </p>
        </div>
        <div className="pms__actions">
          <button
            type="button"
            className="pms__btn"
            disabled={importBusy}
            onClick={() => fileRef.current?.click()}
            title={
              view === "history"
                ? "Import a maintenance HISTORY file (performed records) — PDF, Excel, CSV or text. AI maps it to completed entries."
                : "Import a task list — PDF, Excel, CSV or text. AI maps it to planned tasks."
            }
          >
            <UploadIcon />{" "}
            {importBusy
              ? "Reading…"
              : view === "history"
                ? "Import history"
                : "Import"}
          </button>
          <button
            type="button"
            className="pms__btn pms__btn--primary"
            onClick={openCreate}
          >
            <PlusIcon /> Create task
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pdf,.xlsx,.xls,.csv,.txt,application/pdf,text/csv,text/plain"
            style={{ display: "none" }}
            onChange={onFileChange}
          />
        </div>
      </div>

      <div className="pms__viewtabs">
        <button
          type="button"
          className={`pms__viewtab${view === "active" ? " pms__viewtab--on" : ""}`}
          onClick={() => setView("active")}
        >
          Active <span className="pms__viewtab-n">{active.length}</span>
        </button>
        <button
          type="button"
          className={`pms__viewtab${view === "history" ? " pms__viewtab--on" : ""}`}
          onClick={() => setView("history")}
        >
          History <span className="pms__viewtab-n">{history.length}</span>
        </button>
      </div>

      <div className="pms__toolbar">
        <input
          type="search"
          className="pms__search"
          placeholder="Search tasks, assets, group or person…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {importNote && <div className="pms__import-note">{importNote}</div>}

      <div className="pms__table-wrap">
        <table className="pms__table">
          <thead>
            <tr>
              <th>
                <HeaderFilter
                  label="Status"
                  value={statusFilter ?? "all"}
                  active={!!statusFilter}
                  onChange={(v) =>
                    setStatusFilter(v === "all" ? null : (v as PmsStatus))
                  }
                  options={[
                    { value: "all", label: "All" },
                    { value: "overdue", label: "Overdue" },
                    { value: "due-soon", label: "Due soon" },
                    { value: "ok", label: "OK" },
                  ]}
                />
              </th>
              <th>Task</th>
              <th>
                <HeaderFilter
                  label="Asset"
                  value={assetFilter}
                  active={assetFilter !== "all"}
                  onChange={setAssetFilter}
                  options={[
                    { value: "all", label: "All assets" },
                    ...columnFilterOpts.assets.map((a) => ({
                      value: a,
                      label: a,
                    })),
                  ]}
                />
              </th>
              <th>
                <HeaderFilter
                  label={view === "history" ? "Done by" : "Responsible"}
                  value={personFilter}
                  active={personFilter !== "all"}
                  onChange={setPersonFilter}
                  options={[
                    { value: "all", label: "All" },
                    ...columnFilterOpts.persons.map((p) => ({
                      value: p,
                      label: p,
                    })),
                  ]}
                />
              </th>
              <th>
                {view === "history" ? (
                  "Completed"
                ) : (
                  <HeaderFilter
                    label="Due"
                    value={dueFilter}
                    active={dueFilter !== "all"}
                    onChange={setDueFilter}
                    options={[
                      { value: "all", label: "All" },
                      { value: "overdue", label: "Overdue" },
                      { value: "week", label: "≤ 7 days" },
                      { value: "month", label: "≤ 30 days" },
                      { value: "later", label: "Later" },
                      { value: "none", label: "No date" },
                    ]}
                  />
                )}
              </th>
              <th aria-label="Actions"></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((t) => (
              <tr
                key={t.id}
                className="pms__row--clickable"
                onClick={() => setDetailId(t.id)}
              >
                <td>
                  {t.completedAt ? (
                    <span className="pms__status pms__status--done">Done</span>
                  ) : (
                    <span className={`pms__status pms__status--${t.status}`}>
                      {STATUS_LABEL[t.status]}
                    </span>
                  )}
                </td>
                <td>
                  <div className="pms__task">
                    <span
                      className={`pms__pri pms__pri--${t.priority}`}
                      title={`${PRIORITY_LABEL[t.priority]} priority`}
                    />
                    {t.task}
                    {isRecurring(t) && (
                      <span className="pms__recur" title="Recurring">
                        ⟳
                      </span>
                    )}
                  </div>
                  <div className="pms__taglist">
                    <span
                      className={`pms__plan pms__plan--${t.planning}`}
                    >
                      {t.planning === "planned" ? "Planned" : "Unplanned"}
                    </span>
                    <span className="pms__cat">{t.category}</span>
                    {t.department && (
                      <span className="pms__dept" title="Department (visibility)">
                        {deptLabel(t.department)}
                      </span>
                    )}
                    {t.source === "hours_reminder" && (
                      <span className="pms__cat" title="Auto monthly hours-reading reminder">
                        monthly reading
                      </span>
                    )}
                    {t.source === "compliance" && (
                      <span
                        className="pms__dept"
                        title="Driven by a compliance certificate — date follows the document"
                      >
                        from certificate
                      </span>
                    )}
                    {t.description && (
                      <span className="pms__detail">
                        {t.description.split("\n")[0]}
                      </span>
                    )}
                  </div>
                </td>
                <td>
                  {t.assets.length > 0 && (
                    <div className="pms__assets">
                      {t.assets.slice(0, 2).map((a) => (
                        <span key={a.id} className="pms__asset-chip">
                          {a.name}
                        </span>
                      ))}
                      {t.assets.length > 2 && (
                        <span className="pms__asset-chip">
                          +{t.assets.length - 2}
                        </span>
                      )}
                    </div>
                  )}
                  {t.sfiGroupName && (
                    <div className="pms__sfi">
                      {t.sfiGroup} · {t.sfiGroupName}
                    </div>
                  )}
                  {t.assets.length === 0 && !t.sfiGroupName && (
                    <span className="pms__person">—</span>
                  )}
                </td>
                <td className="pms__person">
                  {view === "history"
                    ? t.completedByName
                      ? `${t.completedByName}${
                          t.completedByPosition ? ` · ${t.completedByPosition}` : ""
                        }`
                      : (t.responsibleRole ?? "—")
                    : (t.responsibleRole ?? "—")}
                </td>
                <td
                  className={
                    t.completedAt
                      ? "pms__due"
                      : t.status === "overdue"
                        ? "pms__due pms__due--danger"
                        : t.status === "due-soon"
                          ? "pms__due pms__due--warn"
                          : "pms__due"
                  }
                >
                  {t.completedAt ?? t.due}
                </td>
                <td>
                  {t.completedAt ? (
                    <button
                      type="button"
                      className="pms__row-action"
                      title="Reopen task"
                      aria-label="Reopen task"
                      onClick={(e) => {
                        e.stopPropagation();
                        reopenTask(t.id);
                      }}
                    >
                      <RefreshIcon />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="pms__row-action"
                      title="Perform (mark done)"
                      aria-label="Perform (mark done)"
                      onClick={(e) => {
                        e.stopPropagation();
                        performTask(t.id);
                      }}
                    >
                      ✓
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="pms__empty">
                  {view === "history"
                    ? "No completed tasks yet — performed tasks move here."
                    : tasks.length === 0
                      ? "No maintenance tasks yet — create or import to get started."
                      : active.length === 0
                        ? "All caught up — no active tasks."
                        : "No tasks match the current filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detailTask &&
        createPortal(
          <TaskDetailModal
            task={detailTask}
            parts={taskParts}
            onClose={() => setDetailId(null)}
            onEdit={() => startEdit(detailTask)}
            onPerform={() => performTask(detailTask.id)}
            onReopen={() => reopenTask(detailTask.id)}
            onDelete={() => deleteTask(detailTask.id)}
          />,
          document.body,
        )}

      {showForm &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pms-form-title"
            onClick={(e) => {
              if (e.target === e.currentTarget) setShowForm(false);
            }}
          >
            <div className="admin-panel__modal pms__modal">
              <button
                type="button"
                className="admin-panel__modal-close"
                onClick={() => setShowForm(false)}
                aria-label="Close"
              >
                <XIcon />
              </button>
              <div className="admin-panel__modal-head">
                <h2 id="pms-form-title" className="admin-panel__modal-title">
                  {editId ? "Edit task" : "Create maintenance task"}
                </h2>
                <p className="admin-panel__modal-desc">
                  Planned tasks recur on an interval; unplanned tasks are
                  one-off by date or running hours.
                </p>
              </div>
              <form onSubmit={submitTask} className="admin-panel__modal-form">
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">Task *</label>
                  <input
                    type="text"
                    className="admin-panel__input admin-panel__input--full"
                    value={form.task}
                    onChange={set("task")}
                    placeholder="e.g. Emergency fire pump — annual service"
                    required
                    autoFocus
                  />
                </div>

                <div className="admin-panel__modal-field-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Category</label>
                    <select
                      className="admin-panel__input admin-panel__input--full"
                      value={form.category}
                      onChange={set("category")}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Priority</label>
                    <select
                      className="admin-panel__input admin-panel__input--full"
                      value={form.priority}
                      onChange={set("priority")}
                    >
                      {(Object.keys(PRIORITY_LABEL) as PmsPriority[]).map((p) => (
                        <option key={p} value={p}>
                          {PRIORITY_LABEL[p]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="admin-panel__modal-field-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Department
                    </label>
                    <select
                      className="admin-panel__input admin-panel__input--full"
                      value={form.department}
                      onChange={set("department")}
                    >
                      {DEPARTMENTS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Position responsible
                    </label>
                    <select
                      className="admin-panel__input admin-panel__input--full"
                      value={form.responsibleRole}
                      onChange={set("responsibleRole")}
                      title="A position, not a person — crew rotate, the position stays. Who actually completes it is recorded in History."
                    >
                      <option value="">— unassigned —</option>
                      {(accessSchema?.positions ?? []).map((p) => (
                        <option key={p.value} value={p.label}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="admin-panel__modal-field-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Group (SFI, optional)
                    </label>
                    <select
                      className="admin-panel__input admin-panel__input--full"
                      value={form.sfiGroup}
                      onChange={set("sfiGroup")}
                    >
                      <option value="">— none —</option>
                      {sfiGroups.map((g) => (
                        <option key={g.code} value={g.code}>
                          {g.code} · {g.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">
                    Linked assets
                  </label>
                  <AssetMultiPicker
                    token={token}
                    shipId={selectedShipId}
                    selected={assetDraft}
                    onChange={setAssetDraft}
                  />
                </div>

                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">
                    Parts / spares
                  </label>
                  {editId ? (
                    <TaskPartsPicker
                      all={allParts}
                      value={taskParts}
                      onChange={(next) => void saveTaskParts(next)}
                    />
                  ) : (
                    <div className="pms__hint">
                      Save the task first, then re-open it to link spare parts.
                    </div>
                  )}
                </div>

                <div className="pms__section-head">Type</div>
                <div className="pms__segmented" role="group">
                  <button
                    type="button"
                    className={`pms__seg${form.planning === "planned" ? " pms__seg--on" : ""}`}
                    onClick={() =>
                      setForm((f) => ({ ...f, planning: "planned" }))
                    }
                  >
                    Planned (recurring)
                  </button>
                  <button
                    type="button"
                    className={`pms__seg${form.planning === "unplanned" ? " pms__seg--on" : ""}`}
                    onClick={() =>
                      setForm((f) => ({ ...f, planning: "unplanned" }))
                    }
                  >
                    Unplanned (one-off)
                  </button>
                </div>

                {form.planning === "planned" ? (
                  <>
                    <div className="admin-panel__modal-field-row">
                      <div className="admin-panel__modal-field">
                        <label className="admin-panel__field-label">
                          Repeat every
                        </label>
                        <input
                          type="number"
                          className="admin-panel__input admin-panel__input--full"
                          value={form.intervalValue}
                          onChange={set("intervalValue")}
                          placeholder="e.g. 12"
                          min={0}
                        />
                      </div>
                      <div className="admin-panel__modal-field">
                        <label className="admin-panel__field-label">Unit</label>
                        <select
                          className="admin-panel__input admin-panel__input--full"
                          value={form.intervalUnit}
                          onChange={set("intervalUnit")}
                        >
                          {INTERVAL_UNITS.map((u) => (
                            <option key={u} value={u}>
                              {u.charAt(0).toUpperCase() + u.slice(1)}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">
                        …and/or service every (running hours)
                      </label>
                      <input
                        type="number"
                        className="admin-panel__input admin-panel__input--full"
                        value={form.intervalHours}
                        onChange={set("intervalHours")}
                        placeholder="e.g. 250"
                        min={0}
                      />
                    </div>
                    <div className="admin-panel__modal-field-row">
                      <div className="admin-panel__modal-field">
                        <label className="admin-panel__field-label">
                          Start from date
                        </label>
                        <input
                          type="date"
                          className="admin-panel__input admin-panel__input--full"
                          value={form.startDate}
                          onChange={set("startDate")}
                        />
                      </div>
                      <div className="admin-panel__modal-field">
                        <label className="admin-panel__field-label">
                          Start from hours
                        </label>
                        <input
                          type="number"
                          className="admin-panel__input admin-panel__input--full"
                          value={form.startHours}
                          onChange={set("startHours")}
                          placeholder="asset hours now"
                          min={0}
                        />
                      </div>
                    </div>
                    <div className="pms__hint">
                      Recurs each time it's performed. Set “start from” when the
                      asset begins service later: the first calendar due is one
                      interval after that date, and the hours countdown is
                      measured from those baseline hours. If both a calendar and
                      an hours interval are set, whichever comes first drives the
                      status.
                    </div>
                  </>
                ) : (
                  <>
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">Due date</label>
                      <input
                        type="date"
                        className="admin-panel__input admin-panel__input--full"
                        value={form.dueDate}
                        onChange={set("dueDate")}
                      />
                    </div>
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">
                        …or due at (running hours)
                      </label>
                      <input
                        type="number"
                        className="admin-panel__input admin-panel__input--full"
                        value={form.dueHours}
                        onChange={set("dueHours")}
                        placeholder="e.g. 11000"
                        min={0}
                      />
                      <div className="pms__hint">
                        One-off. Set a date and/or the running-hours mark when it
                        must be done; current hours come from the asset's metric.
                      </div>
                    </div>
                  </>
                )}

                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">Description</label>
                  <textarea
                    className="admin-panel__input admin-panel__input--full pms__textarea"
                    value={form.description}
                    onChange={set("description")}
                    rows={4}
                    placeholder="What the job involves, parts, notes…"
                  />
                </div>

                <div className="admin-panel__modal-actions">
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--ghost"
                    onClick={() => setShowForm(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="admin-panel__btn admin-panel__btn--primary"
                    disabled={!form.task.trim()}
                  >
                    {editId ? "Save changes" : "Create task"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {importPreview &&
        createPortal(
          <ImportPreviewModal
            preview={importPreview}
            busy={importBusy}
            mode={importMode}
            onCancel={() => setImportPreview(null)}
            onConfirm={commitImport}
          />,
          document.body,
        )}
    </div>
  );
}

interface DraftRow extends PmsImportDraft {
  _key: string;
  _include: boolean;
}

function intervalText(d: PmsImportDraft): string {
  if (d.intervalHours != null) return `every ${d.intervalHours} h`;
  if (d.intervalValue != null) return `every ${d.intervalValue} ${d.intervalUnit ?? "months"}`;
  return "—";
}

/**
 * Reviewable preview of an AI-mapped PMS import. The operator can drop rows,
 * fix the title/category, then confirm — only included rows are committed.
 */
export function ImportPreviewModal({
  preview,
  busy,
  mode = "tasks",
  onCancel,
  onConfirm,
}: {
  preview: PmsImportPreview;
  busy: boolean;
  mode?: PmsImportMode;
  onCancel: () => void;
  onConfirm: (drafts: PmsImportDraft[]) => void;
}) {
  const isHistory = mode === "history";
  // Departments come from the shared access schema (single source) — this modal
  // is a module-level component, so it can't see the parent's DEPARTMENTS.
  const accessSchema = useAccessSchema();
  const DEPARTMENTS = useMemo(
    () => [
      { value: "", label: "General (all crew)" },
      ...(accessSchema?.departments.map((d) => ({
        value: d.key,
        label: d.label,
      })) ?? []),
    ],
    [accessSchema],
  );
  const [rows, setRows] = useState<DraftRow[]>(() =>
    preview.drafts.map((d, i) => ({ ...d, _key: `d${i}`, _include: true })),
  );
  const patch = (key: string, next: Partial<DraftRow>) =>
    setRows((rs) => rs.map((r) => (r._key === key ? { ...r, ...next } : r)));
  const includedCount = rows.filter((r) => r._include).length;

  const confirm = () => {
    const drafts = rows
      .filter((r) => r._include && r.task.trim())
      // strip the UI-only fields
      .map(({ _key, _include, ...d }) => {
        void _key;
        void _include;
        return d;
      });
    onConfirm(drafts);
  };

  return (
    <div className="admin-panel__modal-overlay" onClick={onCancel}>
      <div
        className="admin-panel__modal pms__import-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="admin-panel__modal-header">
          <h3>
            Review import · {preview.counts.total}{" "}
            {isHistory ? "records" : "tasks"} found
          </h3>
          <button
            type="button"
            className="admin-panel__icon-btn"
            onClick={onCancel}
          >
            <XIcon />
          </button>
        </div>

        <div className="pms__import-summary">
          <span>{includedCount} selected</span>
          <span>· {preview.counts.matchedAssets} linked to an asset</span>
          {preview.counts.lowConfidence > 0 && (
            <span className="pms__import-warn">
              · {preview.counts.lowConfidence} need a check
            </span>
          )}
        </div>
        {preview.notes.map((n, i) => (
          <div key={i} className="pms__import-note">{n}</div>
        ))}

        <div className="pms__import-table-wrap">
          <table className="pms__table pms__import-table">
            <thead>
              <tr>
                <th></th>
                <th>Task</th>
                <th>Category</th>
                <th>{isHistory ? "Completed" : "Interval"}</th>
                <th>Who</th>
                <th>Dept</th>
                <th>Asset</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r._key}
                  className={r._include ? "" : "pms__import-row--off"}
                >
                  <td>
                    <input
                      type="checkbox"
                      checked={r._include}
                      onChange={(e) =>
                        patch(r._key, { _include: e.target.checked })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="pms__import-input"
                      value={r.task}
                      onChange={(e) => patch(r._key, { task: e.target.value })}
                    />
                    {r.confidence === "low" && (
                      <span className="pms__import-flag" title="Low confidence — please check">
                        ⚠
                      </span>
                    )}
                  </td>
                  <td>
                    <select
                      className="pms__import-input"
                      value={r.category ?? "Service"}
                      onChange={(e) =>
                        patch(r._key, { category: e.target.value })
                      }
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="pms__import-muted">
                    {isHistory
                      ? [r.completedAt, r.lastDoneHours != null ? `${r.lastDoneHours} h` : null]
                          .filter(Boolean)
                          .join(" · ") || "—"
                      : intervalText(r)}
                  </td>
                  <td className="pms__import-muted">
                    {r.responsibleRole ?? "—"}
                  </td>
                  <td>
                    <select
                      className="pms__import-input"
                      value={r.department ?? ""}
                      onChange={(e) =>
                        patch(r._key, { department: e.target.value || null })
                      }
                    >
                      {DEPARTMENTS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="pms__import-muted">
                    {r.assetMatch ? (
                      <span title={`matched: ${r.assetMatch.matchType}`}>
                        {r.assetMatch.name}
                      </span>
                    ) : r.assetHint ? (
                      <span
                        className="pms__import-warn"
                        title="No matching asset in the register"
                      >
                        {r.assetHint} (unlinked)
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="admin-panel__modal-actions">
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--ghost"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--primary"
            onClick={confirm}
            disabled={busy || includedCount === 0}
          >
            {busy
              ? "Importing…"
              : `Import ${includedCount} ${isHistory ? "record" : "task"}${
                  includedCount === 1 ? "" : "s"
                }`}
          </button>
        </div>
      </div>
    </div>
  );
}

function DlItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="pms__dl-item">
      <span className="pms__dl-label">{label}</span>
      <span className="pms__dl-value">{value ?? "—"}</span>
    </div>
  );
}

function TaskDetailModal({
  task,
  parts,
  onClose,
  onEdit,
  onPerform,
  onReopen,
  onDelete,
}: {
  task: PmsTask;
  parts: InventoryItem[];
  onClose: () => void;
  onEdit: () => void;
  onPerform: () => void;
  onReopen: () => void;
  onDelete: () => void;
}) {
  const repeatDate =
    task.repeatDate && task.intervalValue != null
      ? `every ${intervalLabel(task.intervalValue, task.intervalUnit)}`
      : "—";

  const hoursService =
    task.intervalHours != null ? `every ${task.intervalHours} h` : "—";

  const nextDueHours =
    task.dueHours != null
      ? `${task.dueHours} h${
          task.currentHours != null
            ? ` (${deriveHours(task.currentHours, task.dueHours).due})`
            : ""
        }`
      : task.intervalHours != null && task.currentHours != null
        ? `${nextHoursMark(task.currentHours, task.intervalHours)} h`
        : task.intervalHours != null
          ? "awaiting metric"
          : "—";

  const planned = task.planning === "planned";

  return (
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pms-detail-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="admin-panel__modal pms__modal">
        <button
          type="button"
          className="admin-panel__modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          <XIcon />
        </button>
        <div className="admin-panel__modal-head">
          <div className="pms__detail-title-row">
            <span className={`pms__pri pms__pri--${task.priority}`} />
            <h2 id="pms-detail-title" className="admin-panel__modal-title">
              {task.task}
            </h2>
            {task.completedAt ? (
              <span className="pms__status pms__status--done">Done</span>
            ) : (
              <span className={`pms__status pms__status--${task.status}`}>
                {STATUS_LABEL[task.status]}
              </span>
            )}
          </div>
        </div>

        <div className="pms__section-head">General</div>
        <div className="pms__dl">
          <DlItem label="Type" value={planned ? "Planned" : "Unplanned"} />
          <DlItem label="Category" value={task.category} />
          <DlItem label="Priority" value={PRIORITY_LABEL[task.priority]} />
          <DlItem label="Person responsible" value={task.assigneeName ?? "—"} />
          <DlItem
            label="Group (SFI)"
            value={
              task.sfiGroupName ? `${task.sfiGroup} · ${task.sfiGroupName}` : "—"
            }
          />
        </div>

        <div className="pms__dl-item" style={{ marginBottom: 12 }}>
          <span className="pms__dl-label">Linked assets</span>
          <span className="pms__dl-value">
            {task.assets.length === 0 ? (
              "—"
            ) : (
              <span className="pms__assets">
                {task.assets.map((a) => (
                  <span key={a.id} className="pms__asset-chip">
                    {a.name}
                  </span>
                ))}
              </span>
            )}
          </span>
        </div>

        <div className="pms__dl-item" style={{ marginBottom: 12 }}>
          <span className="pms__dl-label">Parts / spares</span>
          <span className="pms__dl-value">
            {parts.length === 0 ? (
              "—"
            ) : (
              <span className="pms__assets">
                {parts.map((p) => (
                  <span key={p.id} className="pms__asset-chip">
                    {p.name}
                    {p.partNumber ? ` · ${p.partNumber}` : ""}
                  </span>
                ))}
              </span>
            )}
          </span>
        </div>

        <div className="pms__section-head">Schedule</div>
        <div className="pms__dl">
          <DlItem
            label={planned ? "Next due" : "Due date"}
            value={
              task.dueDate
                ? `${task.dueDate} (${deriveDue(task.dueDate).due})`
                : "—"
            }
          />
          {planned ? (
            <>
              <DlItem label="Repeat (calendar)" value={repeatDate} />
              <DlItem label="Service interval (hours)" value={hoursService} />
            </>
          ) : (
            <DlItem label="Due at (hours)" value={nextDueHours} />
          )}
          <DlItem
            label="Current hours"
            value={
              task.currentHours != null
                ? `${task.currentHours} h`
                : "from metrics (pending)"
            }
          />
          {planned && <DlItem label="Next due (hours)" value={nextDueHours} />}
          <DlItem label="Last done" value={task.lastDone ?? "—"} />
        </div>

        {task.completedAt && (
          <div className="pms__dl" style={{ marginTop: 12 }}>
            <DlItem label="Completed" value={task.completedAt} />
          </div>
        )}

        {task.description && (
          <>
            <div className="pms__section-head">Description</div>
            <div className="pms__jd">{task.description}</div>
          </>
        )}

        <div className="admin-panel__modal-actions">
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--ghost pms__btn-danger"
            onClick={onDelete}
          >
            <TrashIcon /> Delete
          </button>
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--ghost"
            onClick={onEdit}
          >
            Edit
          </button>
          {task.completedAt ? (
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--primary"
              onClick={() => {
                onReopen();
                onClose();
              }}
            >
              Reopen
            </button>
          ) : (
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--primary"
              onClick={() => {
                onPerform();
                onClose();
              }}
            >
              Perform
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
