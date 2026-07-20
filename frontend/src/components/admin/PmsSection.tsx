import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { PlusIcon, XIcon, RefreshIcon, UploadIcon } from "./AdminPanelIcons";
import { fetchSfiGroups, type SfiNode } from "../../api/sfiApi";
import { listAssets } from "../../api/assetsApi";
import { AssetMultiSelect, type AssetOption } from "./AssetMultiSelect";
import { useAccessSchema } from "../../hooks/useAccessSchema";
import {
  listPmsTasks,
  createPmsTask,
  updatePmsTask,
  completePmsTask,
  postponePmsTask,
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
import {
  CATEGORIES,
  GENERAL_CATEGORIES,
  INTERVAL_UNITS,
  STATUS_LABEL,
  STATUS_ORDER,
  addInterval,
  deriveHours,
  dueHorizon,
  repeatLabel,
  todayIso,
  type IntervalUnit,
  type LinkedAsset,
  type PmsBoard,
  type PmsCategory,
  type PmsPlanning,
  type PmsPriority,
  type PmsStatus,
  type PmsTask,
} from "./pms/taskTypes";
import { TaskPartsPicker } from "./pms/TaskPartsPicker";
import { TaskDetailDrawer } from "./pms/TaskDetailDrawer";
import { HoursBindingModal } from "./pms/HoursBindingModal";

interface PmsSectionProps {
  token: string | null;
  /**
   * Which board this section shows:
   *  'maintenance' — equipment upkeep tied to assets (Maintenance Plan);
   *  'general'     — people-directed work: certificates, drills, assignments.
   */
  board?: PmsBoard;
}

/** Per-board copy + behaviour. */
const BOARD_CONFIG = {
  maintenance: {
    title: "Maintenance Plan",
    subtitle:
      "Planned maintenance across the vessel — by date and/or running hours, linked to assets.",
    categories: CATEGORIES,
    canImport: true,
    emptyHint: "No maintenance tasks yet — create or import to get started.",
    createTitle: "Create maintenance task",
  },
  general: {
    title: "Tasks",
    subtitle:
      "Certificates, drills and personal assignments — work directed at people, not equipment.",
    categories: GENERAL_CATEGORIES,
    canImport: false,
    emptyHint: "No tasks yet — create one to get started.",
    createTitle: "Create task",
  },
} as const;

// Departments come from the shared access taxonomy (useAccessSchema) — see the
// component body. "" = general/all crew.

/** History's "Completed" cell: a readable date, not the raw ISO timestamp. */
function fmtCompletedAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
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
  const [assetOptions, setAssetOptions] = useState<AssetOption[]>([]);
  useEffect(() => {
    if (!token || !shipId) return;
    void listAssets(token, shipId, { limit: 2000 })
      .then((r) =>
        setAssetOptions(
          r.items.map((a) => ({
            id: a.id,
            label: `${a.assetIdInternal} — ${a.displayName}`,
            sfiGroup: a.sfiGroup,
            sfiGroupName: a.sfiGroupName,
            sfiSub: a.sfiSub,
            sfiSubName: a.sfiSubName,
          })),
        ),
      )
      .catch(() => setAssetOptions([]));
  }, [token, shipId]);

  const byId = new Map(assetOptions.map((a) => [a.id, a]));
  return (
    <AssetMultiSelect
      assets={assetOptions}
      value={selected.map((s) => s.id)}
      onChange={(ids) =>
        onChange(
          ids.map((id) => ({
            id,
            name:
              byId.get(id)?.label ??
              selected.find((s) => s.id === id)?.name ??
              id,
          })),
        )
      }
      placeholder={shipId ? "Link asset(s)…" : "Select a vessel first"}
    />
  );
}

export function PmsSection({ token, board = "maintenance" }: PmsSectionProps) {
  const boardCfg = BOARD_CONFIG[board];
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
  // Per-column filters for the task table (all but Task).
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [deptFilter, setDeptFilter] = useState<string>("all");
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
  const [hoursModalOpen, setHoursModalOpen] = useState(false);
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

  // Tasks come from the backend (pms_tasks), scoped to the active vessel and
  // to THIS board (maintenance plan vs people-directed tasks).
  const refresh = useCallback(async () => {
    if (!token || !shipId) {
      setTasks([]);
      return;
    }
    try {
      const all = (await listPmsTasks(token, shipId)) as unknown as PmsTask[];
      setTasks(all.filter((t) => (t.board ?? "maintenance") === board));
    } catch {
      setTasks([]);
    }
  }, [token, shipId, board]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Ship-level inventory (feeds the per-task parts map + the form's picker).
  const refreshParts = useCallback(async () => {
    if (!token || !shipId) {
      setAllParts([]);
      return;
    }
    try {
      setAllParts(await listInventory(token, shipId));
    } catch {
      setAllParts([]);
    }
  }, [token, shipId]);

  useEffect(() => {
    void refreshParts();
  }, [refreshParts]);

  // taskId → linked inventory items (inventory rows carry their task links).
  const partsByTask = useMemo(() => {
    const map = new Map<string, InventoryItem[]>();
    for (const item of allParts) {
      for (const tid of item.taskIds ?? []) {
        const arr = map.get(tid) ?? [];
        arr.push(item);
        map.set(tid, arr);
      }
    }
    return map;
  }, [allParts]);

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
    board, // tasks created/edited here belong to this section's board
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
          (deptFilter === "all" || (t.department ?? "") === deptFilter) &&
          (assetFilter === "all" ||
            t.assets.some((a) => a.name === assetFilter)) &&
          (personFilter === "all" ||
            (view === "history" ? t.completedByName : t.responsibleRole) ===
              personFilter) &&
          (dueFilter === "all" || dueHorizon(t) === dueFilter) &&
          (!q ||
            t.task.toLowerCase().includes(q) ||
            (t.taskCode ?? "").toLowerCase().includes(q) ||
            (t.externalRef ?? "").toLowerCase().includes(q) ||
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
    deptFilter,
    assetFilter,
    personFilter,
    dueFilter,
    search,
  ]);

  const detailTask = useMemo(
    () => tasks.find((t) => t.id === detailId) ?? null,
    [tasks, detailId],
  );

  const set =
    (key: keyof PmsForm) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
      >,
    ) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const openCreate = () => {
    setForm({
      ...EMPTY_FORM,
      // Sensible per-board default: hand-created general tasks are usually
      // personal assignments; maintenance ones are equipment service.
      category: (board === "general"
        ? "Assignment"
        : EMPTY_FORM.category) as PmsCategory,
    });
    setAssetDraft([]);
    setEditId(null);
    setShowForm(true);
    setTaskPartsState([]);
  };

  const startEdit = (t: PmsTask) => {
    setForm(formFromTask(t));
    setAssetDraft([...t.assets]);
    setEditId(t.id);
    // Keep detailId — the form panel replaces the view drawer; closing the
    // form drops back to the task's view.
    setShowForm(true);
    setTaskPartsState(partsByTask.get(t.id) ?? []);
    if (token && shipId) {
      void listTaskInventory(token, shipId, t.id)
        .then(setTaskPartsState)
        .catch(() => undefined);
    }
  };

  /** Persist the task's linked parts (only when editing an existing task). */
  const saveTaskParts = async (next: InventoryItem[]) => {
    setTaskPartsState(next);
    if (!token || !shipId || !editId) return;
    try {
      await setTaskParts(token, shipId, editId, next.map((p) => p.id));
      void refreshParts(); // keep the table's parts chips in sync
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
    const stagedParts = taskParts;
    void (async () => {
      try {
        if (editId) {
          await updatePmsTask(token, shipId, editId, input);
        } else {
          // Create, then attach the parts staged in the form.
          const created = await createPmsTask(token, shipId, input);
          if (created?.id && stagedParts.length > 0) {
            await setTaskParts(
              token,
              shipId,
              created.id,
              stagedParts.map((p) => p.id),
            );
          }
          if (created?.id) setDetailId(created.id); // open the new task
        }
        await refresh();
        await refreshParts();
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

  const postponeTask = (
    id: string,
    input: { intervalValue: number; intervalUnit: string; reason: string },
  ) => {
    if (!token || !shipId) return;
    void postponePmsTask(token, shipId, id, input)
      .then(refresh)
      .catch((e) =>
        setImportNote(
          e instanceof Error ? e.message : "Failed to postpone task",
        ),
      );
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
      const result = await commitPmsImport(token, shipId, drafts, importMode);
      setImportPreview(null);
      const bits = [
        `Imported ${result.created} ${
          importMode === "history" ? "record" : "task"
        }${result.created === 1 ? "" : "s"}`,
      ];
      if (result.updated > 0)
        bits.push(`${result.updated} updated by reference id`);
      if (result.partsCreated > 0)
        bits.push(`${result.partsCreated} spare part${result.partsCreated === 1 ? "" : "s"} added to inventory`);
      setImportNote(`${bits.join(" · ")}.`);
      await refresh();
      await refreshParts();
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
          <h2 className="pms__title">{boardCfg.title}</h2>
          <p className="pms__subtitle">{boardCfg.subtitle}</p>
        </div>
        <div className="pms__actions">
          {boardCfg.canImport && (
            <button
              type="button"
              className="pms__btn"
              onClick={() => setHoursModalOpen(true)}
              title="Bind assets to running-hour counters in bulk — hour-interval tasks need a source to compute due status."
            >
              Hours
            </button>
          )}
          {boardCfg.canImport && (
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
          )}
          <button
            type="button"
            className="pms__btn pms__btn--primary"
            onClick={openCreate}
          >
            <PlusIcon /> Create task
          </button>
          {boardCfg.canImport && (
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.xlsx,.xls,.csv,.txt,application/pdf,text/csv,text/plain"
              style={{ display: "none" }}
              onChange={onFileChange}
            />
          )}
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
              <th>Type</th>
              <th>
                <HeaderFilter
                  label="Category"
                  value={categoryFilter}
                  active={categoryFilter !== "all"}
                  onChange={setCategoryFilter}
                  options={[
                    { value: "all", label: "All categories" },
                    ...boardCfg.categories.map((c) => ({
                      value: c,
                      label: c,
                    })),
                  ]}
                />
              </th>
              <th>
                <HeaderFilter
                  label="Dept"
                  value={deptFilter}
                  active={deptFilter !== "all"}
                  onChange={setDeptFilter}
                  options={[
                    { value: "all", label: "All departments" },
                    ...DEPARTMENTS.map((d) => ({
                      value: d.value,
                      label: d.label,
                    })),
                  ]}
                />
              </th>
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
              <th aria-label="Spare parts">Parts</th>
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
                  {t.taskCode && (
                    <div className="pms__task-code">{t.taskCode}</div>
                  )}
                  <div className="pms__task">{t.task}</div>
                  {(t.source === "hours_reminder" ||
                    t.source === "compliance") && (
                    <div className="pms__taglist">
                      {t.source === "hours_reminder" && (
                        <span
                          className="pms__cat"
                          title="Auto monthly hours-reading reminder"
                        >
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
                    </div>
                  )}
                </td>
                <td>
                  <span className={`pms__plan pms__plan--${t.planning}`}>
                    {t.planning === "planned" ? "Planned" : "Unplanned"}
                  </span>
                </td>
                <td>
                  <span className="pms__cat">{t.category}</span>
                </td>
                <td>
                  {t.department ? (
                    <span className="pms__dept" title="Department (visibility)">
                      {deptLabel(t.department)}
                    </span>
                  ) : (
                    <span className="pms__person">—</span>
                  )}
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
                          t.completedByPosition
                            ? ` · ${t.completedByPosition}`
                            : ""
                        }`
                      : (t.responsibleRole ?? "—")
                    : (t.responsibleRole ?? "—")}
                </td>
                <td className="pms__parts-cell">
                  {(partsByTask.get(t.id)?.length ?? 0) > 0 ? (
                    <span className="pms__parts-n">
                      {partsByTask.get(t.id)?.length}
                    </span>
                  ) : (
                    <span className="pms__person">—</span>
                  )}
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
                  {t.completedAt ? fmtCompletedAt(t.completedAt) : t.due}
                  {!t.completedAt &&
                    (() => {
                      const rep = repeatLabel(t);
                      const hrs =
                        t.currentHours != null && t.dueHours != null
                          ? deriveHours(t.currentHours, t.dueHours).due
                          : null;
                      return (rep || hrs) && (
                        <div className="pms__due-sub">
                          {[rep, hrs].filter(Boolean).join(" · ")}
                        </div>
                      );
                    })()}
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
                <td colSpan={10} className="pms__empty">
                  {view === "history"
                    ? "No completed tasks yet — performed tasks move here."
                    : tasks.length === 0
                      ? boardCfg.emptyHint
                      : active.length === 0
                        ? "All caught up — no active tasks."
                        : "No tasks match the current filters."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detailTask && !showForm && (
        <TaskDetailDrawer
          key={detailTask.id}
          task={detailTask}
          parts={partsByTask.get(detailTask.id) ?? []}
          deptLabel={deptLabel}
          onClose={() => setDetailId(null)}
          onEdit={() => startEdit(detailTask)}
          onPerform={() => performTask(detailTask.id)}
          onReopen={() => reopenTask(detailTask.id)}
          onPostpone={(input) => postponeTask(detailTask.id, input)}
          onDelete={() => deleteTask(detailTask.id)}
        />
      )}

      {showForm &&
        createPortal(
          <div
            className="pms-drawer__overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pms-form-title"
            onClick={(e) => {
              if (e.target === e.currentTarget) setShowForm(false);
            }}
          >
            <aside className="pms-drawer pms-drawer--form">
              <div className="pms-drawer__head">
                <div className="pms-drawer__head-main">
                  <h2 id="pms-form-title" className="pms-drawer__title">
                    {editId ? "Edit task" : boardCfg.createTitle}
                  </h2>
                  <p className="pms-drawer__muted" style={{ marginTop: 4 }}>
                    Planned tasks recur on an interval; unplanned tasks are
                    one-off by date or running hours.
                  </p>
                </div>
                <button
                  type="button"
                  className="pms-drawer__close"
                  onClick={() => setShowForm(false)}
                  aria-label="Close"
                >
                  <XIcon />
                </button>
              </div>
              <form
                onSubmit={submitTask}
                className="admin-panel__modal-form pms-drawer__form"
              >
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
                      {/* Keep an off-board category visible while editing
                          (e.g. a cert task opened on the wrong board). */}
                      {!boardCfg.categories.includes(
                        form.category as never,
                      ) && (
                        <option value={form.category}>{form.category}</option>
                      )}
                      {boardCfg.categories.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
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

                <div className="admin-panel__modal-field-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Position responsible
                    </label>
                    <select
                      className="admin-panel__input admin-panel__input--full"
                      value={form.responsibleRole}
                      onChange={(e) => {
                        const label = e.target.value;
                        // Auto-fill department from the position's own
                        // department (the access schema's source of truth) —
                        // the field to the right stays editable afterward.
                        const dept =
                          accessSchema?.positions.find((p) => p.label === label)
                            ?.department ?? "";
                        setForm((f) => ({
                          ...f,
                          responsibleRole: label,
                          department: label ? dept : f.department,
                        }));
                      }}
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
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Department
                    </label>
                    <select
                      className="admin-panel__input admin-panel__input--full"
                      value={form.department}
                      onChange={set("department")}
                      title="Auto-filled from the position above; you can still override it."
                    >
                      {DEPARTMENTS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.label}
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
                  <TaskPartsPicker
                    all={allParts}
                    value={taskParts}
                    onChange={(next) =>
                      editId
                        ? void saveTaskParts(next)
                        : setTaskPartsState(next) // staged; linked on create
                    }
                  />
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

                <div className="pms-drawer__actions pms-drawer__actions--form">
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
            </aside>
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

      {hoursModalOpen && token && shipId &&
        createPortal(
          <HoursBindingModal
            token={token}
            shipId={shipId}
            onClose={() => setHoursModalOpen(false)}
            onApplied={() => void refresh()}
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
          {(preview.counts.unmatchedAssets ?? 0) > 0 && (
            <span
              className="pms__import-warn"
              title="Not in the register — add these manually, then re-import to link them"
            >
              · {preview.counts.unmatchedAssets} equipment name
              {preview.counts.unmatchedAssets === 1 ? "" : "s"} not in the register
            </span>
          )}
          {(preview.counts.partsTotal ?? 0) > 0 && (
            <span>
              · {preview.counts.partsTotal} spare part
              {preview.counts.partsTotal === 1 ? "" : "s"} → inventory
            </span>
          )}
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
                    {r.externalRef && (
                      <div
                        className="pms__import-ref"
                        title="Source PMS reference — re-importing the same file updates this task instead of duplicating it"
                      >
                        ref {r.externalRef}
                      </div>
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
                        {r.assetMatch.matchType !== "exact" && (
                          <span className="pms__import-matchtype">
                            {" "}
                            · {r.assetMatch.matchType}
                          </span>
                        )}
                      </span>
                    ) : r.assetHint ? (
                      <span
                        className="pms__import-warn"
                        title="Not in the register — add it manually, then re-import to link this task"
                      >
                        {r.assetHint} (unlinked)
                      </span>
                    ) : (
                      "—"
                    )}
                    {(r.parts?.length ?? 0) > 0 && (
                      <span
                        className="pms__import-parts"
                        title={(r.parts ?? [])
                          .map(
                            (p) =>
                              `${p.name}${p.quantity != null ? ` ×${p.quantity}${p.unit ? ` ${p.unit}` : ""}` : ""}${
                                p.manufacturerNo ? ` (${p.manufacturerNo})` : ""
                              }`,
                          )
                          .join("\n")}
                      >
                        🔧 {r.parts?.length}
                      </span>
                    )}
                    {r.intervalHours != null &&
                      r.assetMatch &&
                      (r.assetHoursSource ?? "none") === "none" && (
                        <label
                          className="pms__import-hours-warn"
                          title={`Runs every ${r.intervalHours} h${
                            r.counter ? ` on counter "${r.counter}"` : ""
                          }, but this asset has no running-hours source. Tick to enable MANUAL counting — a monthly "record running hours" reminder task is created; metric-based counting can be set later in the asset's PMS tab.`}
                        >
                          <input
                            type="checkbox"
                            checked={r.enableManualHours === true}
                            onChange={(e) =>
                              patch(r._key, {
                                enableManualHours: e.target.checked,
                              })
                            }
                          />
                          ⏱ no hours source — count manually
                        </label>
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
