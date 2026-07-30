import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatPanelAction } from "./ChatPlusMenu";
import type { ChatPendingActionDto } from "../../types/chat";
import { listCrew, type CrewMemberDto } from "../../api/crewApi";
import { listAssets } from "../../api/assetsApi";
import {
  createPmsTask,
  reportDefect,
  uploadTaskPhoto,
  type PmsTaskDto,
} from "../../api/pmsApi";
import {
  INVENTORY_CATEGORIES,
  INVENTORY_UNITS,
  createInventoryItem,
  listInventory,
  setTaskParts,
  type InventoryItem,
} from "../../api/inventoryApi";
import {
  previewComplianceDocs,
  commitComplianceDocs,
  fetchComplianceOverview,
  fetchComplianceArchetypes,
  type IngestProposal,
  type CommitProposal,
  type ArchetypeSchema,
} from "../../api/complianceApi";
import { ComplianceIngestModal } from "../admin/ComplianceIngestModal";
import { type AssetOption } from "../admin/AssetMultiSelect";

/**
 * The right-side panel that hosts the "+" menu's actions (work order,
 * defect, document, parts) — NOT a popup, it slides in like PmsSidePanel.
 * One component switches on `action`; each form is compact and crew-facing.
 */

const DEPARTMENTS = [
  { key: "", label: "—" },
  { key: "deck", label: "Deck" },
  { key: "engine", label: "Engine" },
  { key: "interior", label: "Interior" },
  { key: "galley", label: "Galley" },
];
const PRIORITIES = ["low", "medium", "high", "critical"] as const;

const TITLES: Record<ChatPanelAction, string> = {
  workorder: "Create work order",
  defect: "Report defect",
  document: "Add document",
  parts: "Add parts",
};

interface AssetSuggestion {
  id: string;
  assetIdInternal: string;
  displayName: string;
}

export function ChatActionPanel({
  action,
  token,
  shipId,
  prefill,
  closing,
  onClose,
}: {
  action: ChatPanelAction;
  token: string | null;
  shipId: string | null | undefined;
  /** A task the assistant proposed and the user accepted with "Yes" — the
   *  form opens filled in so they review/edit before anything is written. */
  prefill?: ChatPendingActionDto | null;
  closing?: boolean;
  onClose: () => void;
}) {
  return (
    <aside
      className={`chat-pms-panel${closing ? " chat-pms-panel--closing" : ""}`}
      aria-label={TITLES[action]}
    >
      <div className="chat-pms-panel__inner capanel">
        <div className="capanel__head">
          <span className="capanel__title">{TITLES[action]}</span>
          <button
            type="button"
            className="capanel__close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="capanel__body">
          {action === "workorder" && (
            <WorkOrderForm token={token} shipId={shipId} prefill={prefill} />
          )}
          {action === "defect" && <DefectForm token={token} shipId={shipId} />}
          {action === "document" && (
            <DocumentForm token={token} shipId={shipId} />
          )}
          {action === "parts" && <PartsForm token={token} shipId={shipId} />}
        </div>
      </div>
    </aside>
  );
}

// ── shared bits ───────────────────────────────────────────────────────────

function usePhotoState() {
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = files.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [files]);
  return { files, setFiles, previews };
}

function PhotoField({
  files,
  setFiles,
  previews,
  disabled,
}: {
  files: File[];
  setFiles: React.Dispatch<React.SetStateAction<File[]>>;
  previews: string[];
  disabled?: boolean;
}) {
  return (
    <div className="capanel__field">
      <label className="capanel__photo-add">
        📷 Add photos
        <input
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          disabled={disabled}
          onChange={(e) => {
            // Read the FileList into a plain array BEFORE clearing the input
            // — clearing e.target.value also clears e.target.files, and a
            // functional setState updater re-reads this closure lazily at
            // render time, after the clear has already happened.
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            setFiles((prev) => [...prev, ...picked]);
          }}
        />
      </label>
      {previews.length > 0 && (
        <div className="capanel__previews">
          {previews.map((url, i) => (
            <div key={url} className="capanel__preview">
              <img src={url} alt={files[i]?.name ?? "photo"} />
              <button
                type="button"
                className="capanel__preview-del"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Remove photo"
                disabled={disabled}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Debounced asset-register search picker (shared by defect + parts). */
function AssetPicker({
  token,
  shipId,
  asset,
  onPick,
  onClear,
  disabled,
}: {
  token: string;
  shipId: string;
  asset: AssetSuggestion | null;
  onPick: (a: AssetSuggestion) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<AssetSuggestion[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (asset || query.trim().length < 2) {
      setOptions([]);
      return;
    }
    const t = window.setTimeout(() => {
      listAssets(token, shipId, { search: query.trim(), limit: 8 })
        .then((r) =>
          setOptions(
            r.items.map((a) => ({
              id: a.id,
              assetIdInternal: a.assetIdInternal,
              displayName: a.displayName,
            })),
          ),
        )
        .catch(() => setOptions([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [query, asset, token, shipId]);

  if (asset) {
    return (
      <div className="capanel__asset-picked">
        {/* The internal register code is plumbing — the crew reads names. */}
        <span className="capanel__asset-name">{asset.displayName}</span>
        <button
          type="button"
          className="capanel__asset-clear"
          onClick={onClear}
          aria-label="Clear"
          disabled={disabled}
        >
          ×
        </button>
      </div>
    );
  }
  return (
    <div className="capanel__asset-search">
      <input
        className="capanel__input"
        placeholder="Search the asset register — fan, DG1, compressor…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        disabled={disabled}
      />
      {open && options.length > 0 && (
        <div className="capanel__asset-options">
          {options.map((a) => (
            <button
              key={a.id}
              type="button"
              className="capanel__asset-option"
              onClick={() => {
                onPick(a);
                setOpen(false);
              }}
            >
              <span className="capanel__asset-name">{a.displayName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CalendarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4" /><path d="M16 3v4" /><path d="M3 10h18" />
    </svg>
  );
}

/** The three dates a due date almost always is, as on the phone. */
const QUICK_DUE = [
  { label: "Today", days: 0 },
  { label: "Tomorrow", days: 1 },
  { label: "In a week", days: 7 },
];

/**
 * A calendar day, not an instant. `toISOString` reads the day in UTC, which in
 * London makes "Today" mean yesterday for the first hour after midnight.
 */
function isoInDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const month = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

/**
 * The three shortcuts plus a calendar button for anything else — the same row
 * the mobile form shows, so a due date is one click on either.
 *
 * The calendar itself stays NATIVE: <input type="date"> is the platform's own
 * picker, and there is no reason to draw a month grid over it. What it must not
 * do is render the value, because native <input type="date"> uses the BROWSER's
 * OS locale — Chrome ignores both the document lang and navigator.language, so
 * a due date showed as 08/01/2026 and read as 8 January to half the crew. The
 * chosen date is therefore spelled out underneath as "1 Aug 2026".
 */
function DateField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const label = value
    ? new Date(`${value}T00:00:00`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";
  const quick = QUICK_DUE.map((q) => ({ ...q, iso: isoInDays(q.days) }));
  // A date that is none of the shortcuts came from the calendar, so the
  // calendar button is the one that reads as chosen.
  const custom = !!value && !quick.some((q) => q.iso === value);
  const openPicker = () => {
    const el = ref.current;
    if (!el || disabled) return;
    // showPicker() is Chrome/Edge/Safari 16+; focus is the graceful fallback.
    if (typeof el.showPicker === "function") el.showPicker();
    else el.focus();
  };
  return (
    <div className="capanel__date">
      <div className="capanel__chips">
        {quick.map((q) => (
          <button
            key={q.label}
            type="button"
            className={`capanel__chip${value === q.iso ? " capanel__chip--on" : ""}`}
            onClick={() => onChange(q.iso)}
            disabled={disabled}
          >
            {q.label}
          </button>
        ))}
        <button
          type="button"
          className={`capanel__chip capanel__date-chip${custom ? " capanel__chip--on" : ""}`}
          onClick={openPicker}
          disabled={disabled}
          aria-label="Pick another date"
          title="Pick another date"
        >
          <CalendarIcon />
        </button>
      </div>
      <input
        ref={ref}
        type="date"
        className="capanel__date-native"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        tabIndex={-1}
        aria-hidden
      />
      {!!label && <div className="capanel__date-value">Due {label}</div>}
    </div>
  );
}

function Done({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="capanel__done">
      <div className="capanel__done-icon">✅</div>
      <p className="capanel__done-text">{text}</p>
      <button type="button" className="capanel__btn capanel__btn--primary" onClick={onClose}>
        Done
      </button>
    </div>
  );
}

// ── 1. Work order ─────────────────────────────────────────────────────────

function WorkOrderForm({
  token,
  shipId,
  prefill,
}: {
  token: string | null;
  shipId: string | null | undefined;
  prefill?: ChatPendingActionDto | null;
}) {
  const [title, setTitle] = useState(prefill?.task ?? "");
  const [details, setDetails] = useState(prefill?.description ?? "");
  const [assigneeUserId, setAssigneeUserId] = useState("");
  const [department, setDepartment] = useState(prefill?.department ?? "");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>(
    (PRIORITIES as readonly string[]).includes(prefill?.priority ?? "")
      ? (prefill?.priority as (typeof PRIORITIES)[number])
      : "medium",
  );
  const [dueDate, setDueDate] = useState(prefill?.dueDate ?? "");
  const [asset, setAsset] = useState<AssetSuggestion | null>(null);
  const { files, setFiles, previews } = usePhotoState();
  const [crew, setCrew] = useState<CrewMemberDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<PmsTaskDto | null>(null);

  useEffect(() => {
    if (!token || !shipId) return;
    listCrew(token, shipId).then(setCrew).catch(() => setCrew([]));
  }, [token, shipId]);

  // The proposal names people and equipment the way the user said them; the
  // form needs ids. Resolve both once the roster/register answer.
  useEffect(() => {
    const wanted = prefill?.assignee?.trim().toLowerCase();
    if (!wanted || crew.length === 0) return;
    // Search the WHOLE roster, not the department-filtered list: the
    // proposal's department is the model's guess (a davit job reads as
    // "deck") while the named person may sit elsewhere (Diego is engine).
    // The person the user actually named wins, and the department follows
    // them — otherwise the filter hides them and the field stays empty.
    const hit = crew.find(
      (c) =>
        c.active &&
        c.accountUserId &&
        (c.name.toLowerCase() === wanted ||
          c.name.toLowerCase().includes(wanted) ||
          (c.rank ?? "").toLowerCase().includes(wanted)),
    );
    if (!hit?.accountUserId) return;
    setDepartment(hit.department ?? "");
    setAssigneeUserId(hit.accountUserId);
  }, [prefill?.assignee, crew]);

  useEffect(() => {
    const code = prefill?.assetIdInternal?.trim();
    if (!code || !token || !shipId) return;
    listAssets(token, shipId, { search: code, limit: 5 })
      .then((r) => {
        const hit = r.items.find((a) => a.assetIdInternal === code);
        if (hit)
          setAsset({
            id: hit.id,
            assetIdInternal: hit.assetIdInternal,
            displayName: hit.displayName,
          });
      })
      .catch(() => undefined);
  }, [prefill?.assetIdInternal, token, shipId]);

  // Only crew with a login can be assigned; when a department is picked the
  // list narrows to that department (matches how an officer thinks: "who on
  // deck can do this?"). Selecting a department that excludes the current
  // assignee clears it.
  const assignable = useMemo(
    () =>
      crew.filter(
        (c) =>
          c.active &&
          c.accountUserId &&
          (!department || c.department === department),
      ),
    [crew, department],
  );
  useEffect(() => {
    if (
      assigneeUserId &&
      !assignable.some((c) => c.accountUserId === assigneeUserId)
    ) {
      setAssigneeUserId("");
    }
  }, [assignable, assigneeUserId]);

  const submit = async () => {
    if (!token || !shipId || !title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const task = await createPmsTask(token, shipId, {
        task: title.trim(),
        // Equipment work belongs on the maintenance plan; people-directed
        // chores stay on the general Tasks board (same split the assistant's
        // create_maintenance_task tool enforces server-side).
        board: asset ? "maintenance" : "general",
        assetIds: asset ? [asset.id] : undefined,
        planning: "unplanned",
        priority,
        department: department || null,
        assigneeUserId: assigneeUserId || null,
        dueDate: dueDate || null,
        description: details.trim() || null,
      });
      for (const file of files) {
        try {
          await uploadTaskPhoto(token, shipId, task.id, file, "issue");
        } catch {
          /* keep the task; photo failures are non-fatal */
        }
      }
      setDone(task);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create work order");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const who = assignable.find((c) => c.accountUserId === assigneeUserId);
    return (
      <Done
        text={`Work order ${done.taskCode ?? ""} created on the ${asset ? "maintenance plan" : "Tasks board"}${asset ? ` for ${asset.displayName}` : ""}${who ? `, assigned to ${who.name}` : ""}. It appears in their tasks.`}
        onClose={() => {
          setDone(null);
          setTitle("");
          setDetails("");
          setAssigneeUserId("");
          setAsset(null);
          setFiles([]);
        }}
      />
    );
  }

  return (
    <>
      <input
        className="capanel__input"
        placeholder="What needs doing? (short title)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
        autoFocus
        disabled={busy}
      />
      <textarea
        className="capanel__input capanel__textarea"
        placeholder="Instructions / details (optional)"
        rows={3}
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        disabled={busy}
      />
      <div className="capanel__field">
        <span className="capanel__label">Equipment (optional)</span>
        {token && shipId && (
          <AssetPicker
            token={token}
            shipId={shipId}
            asset={asset}
            onPick={setAsset}
            onClear={() => setAsset(null)}
            disabled={busy}
          />
        )}
        <span className="capanel__hint">
          Linking equipment files this on the maintenance plan instead of the
          general Tasks board.
        </span>
      </div>
      <div className="capanel__field">
        <span className="capanel__label">Department</span>
        <div className="capanel__chips">
          {DEPARTMENTS.map((d) => (
            <button
              key={d.key}
              type="button"
              className={`capanel__chip${department === d.key ? " capanel__chip--on" : ""}`}
              onClick={() => setDepartment(d.key)}
              disabled={busy}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
      <div className="capanel__field">
        <span className="capanel__label">Assign to</span>
        <select
          className="capanel__input"
          value={assigneeUserId}
          onChange={(e) => setAssigneeUserId(e.target.value)}
          disabled={busy}
        >
          <option value="">— unassigned —</option>
          {assignable.map((c) => (
            <option key={c.id} value={c.accountUserId!}>
              {c.name} · {c.rank}
            </option>
          ))}
        </select>
        {assignable.length === 0 && (
          <span className="capanel__hint">
            {department
              ? "No crew with a login in this department — issue logins from the Crew tab."
              : "No crew with a login yet — issue logins from the Crew tab to assign."}
          </span>
        )}
      </div>
      <div className="capanel__row2">
        <div className="capanel__field">
          <span className="capanel__label">Priority</span>
          <select
            className="capanel__input"
            value={priority}
            onChange={(e) =>
              setPriority(e.target.value as (typeof PRIORITIES)[number])
            }
            disabled={busy}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p[0].toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div className="capanel__field">
          <span className="capanel__label">Due date</span>
          <DateField value={dueDate} onChange={setDueDate} disabled={busy} />
        </div>
      </div>
      <PhotoField files={files} setFiles={setFiles} previews={previews} disabled={busy} />
      {error && <div className="capanel__error">{error}</div>}
      <button
        type="button"
        className="capanel__btn capanel__btn--primary capanel__submit"
        onClick={() => void submit()}
        disabled={busy || !title.trim()}
      >
        {busy ? "Creating…" : "Create work order"}
      </button>
    </>
  );
}

// ── 2. Defect ─────────────────────────────────────────────────────────────

function DefectForm({
  token,
  shipId,
}: {
  token: string | null;
  shipId: string | null | undefined;
}) {
  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [department, setDepartment] = useState("");
  const [asset, setAsset] = useState<AssetSuggestion | null>(null);
  const { files, setFiles, previews } = usePhotoState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ taskCode: string | null } | null>(null);

  // Used parts — inventory loaded once, filtered client-side, multi-select.
  const [partQuery, setPartQuery] = useState("");
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [usedParts, setUsedParts] = useState<InventoryItem[]>([]);
  useEffect(() => {
    if (!token || !shipId) return;
    listInventory(token, shipId).then(setInventory).catch(() => setInventory([]));
  }, [token, shipId]);
  const partOptions = useMemo(() => {
    const q = partQuery.trim().toLowerCase();
    if (q.length < 2) return [];
    return inventory
      .filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.partNumber ?? "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [partQuery, inventory]);

  const submit = async () => {
    if (!token || !shipId || !title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await reportDefect(token, shipId, {
        type: "defect",
        title: title.trim(),
        description: details.trim() || null,
        department: department || null,
        assetId: asset?.id ?? null,
      });
      for (const file of files) {
        try {
          await uploadTaskPhoto(token, shipId, created.taskId, file, "issue");
        } catch {
          /* non-fatal */
        }
      }
      if (usedParts.length > 0) {
        try {
          await setTaskParts(
            token,
            shipId,
            created.taskId,
            usedParts.map((p) => p.id),
          );
        } catch {
          /* non-fatal */
        }
      }
      setDone({ taskCode: created.taskCode });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to report the defect");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Done
        text={`Defect logged as ${done.taskCode ?? "a task"} — recorded against the equipment${asset ? ` (${asset.displayName})` : ""} and the maintenance plan. Future crews will see this failure history.`}
        onClose={() => {
          setDone(null);
          setTitle("");
          setDetails("");
          setAsset(null);
          setUsedParts([]);
          setFiles([]);
        }}
      />
    );
  }

  return (
    <>
      <input
        className="capanel__input"
        placeholder="What broke / what's wrong? (short title)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
        autoFocus
        disabled={busy}
      />
      <textarea
        className="capanel__input capanel__textarea"
        placeholder="What happened, cause, what you did to fix it…"
        rows={3}
        value={details}
        onChange={(e) => setDetails(e.target.value)}
        disabled={busy}
      />
      <div className="capanel__field">
        <span className="capanel__label">Equipment</span>
        {token && shipId && (
          <AssetPicker
            token={token}
            shipId={shipId}
            asset={asset}
            onPick={setAsset}
            onClear={() => setAsset(null)}
            disabled={busy}
          />
        )}
      </div>
      <div className="capanel__field">
        <span className="capanel__label">Parts used (optional)</span>
        {usedParts.length > 0 && (
          <div className="capanel__parts">
            {usedParts.map((p) => (
              <span key={p.id} className="capanel__part-chip">
                {p.name}
                <button
                  type="button"
                  onClick={() =>
                    setUsedParts((prev) => prev.filter((x) => x.id !== p.id))
                  }
                  aria-label="Remove part"
                  disabled={busy}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="capanel__asset-search">
          <input
            className="capanel__input"
            placeholder="Search inventory — filter, belt, gasket…"
            value={partQuery}
            onChange={(e) => setPartQuery(e.target.value)}
            disabled={busy}
          />
          {partOptions.length > 0 && (
            <div className="capanel__asset-options">
              {partOptions
                .filter((o) => !usedParts.some((u) => u.id === o.id))
                .map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    className="capanel__asset-option"
                    onClick={() => {
                      setUsedParts((prev) => [...prev, o]);
                      setPartQuery("");
                    }}
                  >
                    <span className="capanel__asset-name">{o.name}</span>
                    {o.partNumber && (
                      <span className="capanel__asset-code">{o.partNumber}</span>
                    )}
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>
      <div className="capanel__field">
        <span className="capanel__label">Department</span>
        <div className="capanel__chips">
          {DEPARTMENTS.map((d) => (
            <button
              key={d.key}
              type="button"
              className={`capanel__chip${department === d.key ? " capanel__chip--on" : ""}`}
              onClick={() => setDepartment(d.key)}
              disabled={busy}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>
      <PhotoField files={files} setFiles={setFiles} previews={previews} disabled={busy} />
      {error && <div className="capanel__error">{error}</div>}
      <button
        type="button"
        className="capanel__btn capanel__btn--primary capanel__submit"
        onClick={() => void submit()}
        disabled={busy || !title.trim()}
      >
        {busy ? "Logging…" : "Log defect"}
      </button>
    </>
  );
}

// ── 3. Add document (certificate) ──────────────────────────────────────────

interface DocTypeOption {
  id: string;
  sfiCode: string;
  name: string;
  sectionCode: string;
  sectionName: string;
  archetype: string | null;
}

function DocumentForm({
  token,
  shipId,
}: {
  token: string | null;
  shipId: string | null | undefined;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<number | null>(null);
  // Review is handed off to the FULL admin ingest modal (categories,
  // archetype-driven fields, document preview) — reused as-is.
  const [review, setReview] = useState<{
    proposals: IngestProposal[];
    files: File[];
  } | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);

  // Reference data the admin review modal needs: doc types, archetype field
  // schema, and asset options for per-unit certificate linking.
  const [types, setTypes] = useState<DocTypeOption[]>([]);
  const [schema, setSchema] = useState<ArchetypeSchema | null>(null);
  const [assetOptions, setAssetOptions] = useState<AssetOption[]>([]);
  useEffect(() => {
    if (!token || !shipId) return;
    void fetchComplianceOverview(token, shipId)
      .then((ov) =>
        setTypes(
          (ov.sections ?? []).flatMap((s) =>
            s.types.map((t) => ({
              id: t.id,
              sfiCode: t.sfiCode,
              name: t.name,
              sectionCode: s.sectionCode,
              sectionName: s.sectionName,
              archetype: t.archetype,
            })),
          ),
        ),
      )
      .catch(() => setTypes([]));
    void fetchComplianceArchetypes(token, shipId)
      .then(setSchema)
      .catch(() => setSchema(null));
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

  const preview = async () => {
    if (!token || !shipId || files.length === 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await previewComplianceDocs(token, shipId, files);
      setReview({ proposals: res.proposals, files });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read the documents");
    } finally {
      setBusy(false);
    }
  };

  const commit = async (proposals: CommitProposal[]) => {
    if (!token || !shipId || !review) return;
    setBusy(true);
    setCommitError(null);
    try {
      const { created } = await commitComplianceDocs(
        token,
        shipId,
        proposals,
        review.files,
      );
      if (created < proposals.length) {
        setCommitError(
          `Saved ${created} of ${proposals.length}. ${proposals.length - created} could not be saved — check the required fields (marked *).`,
        );
      } else {
        setReview(null);
        setDone(created);
      }
    } catch (e) {
      setCommitError(
        e instanceof Error ? e.message : "Failed to save the documents",
      );
    } finally {
      setBusy(false);
    }
  };

  if (done !== null) {
    return (
      <Done
        text={`${done} document(s) saved to the compliance register.`}
        onClose={() => {
          setDone(null);
          setFiles([]);
        }}
      />
    );
  }

  return (
    <>
      <p className="capanel__hint">
        Upload certificates or class/flag documents. The assistant reads each
        one; you review and confirm — with categories, per-type fields and a
        document preview — before it goes to the register.
      </p>
      <label className="capanel__photo-add capanel__doc-drop">
        📄 Choose files (PDF or photo)
        <input
          type="file"
          accept="application/pdf,image/*"
          multiple
          style={{ display: "none" }}
          disabled={busy}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            e.target.value = "";
            setFiles((prev) => [...prev, ...picked]);
          }}
        />
      </label>
      {files.length > 0 && (
        <ul className="capanel__doc-list">
          {files.map((f, i) => (
            <li key={f.name + i}>
              <span>{f.name}</span>
              <button
                type="button"
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                aria-label="Remove"
                disabled={busy}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <div className="capanel__error">{error}</div>}
      <button
        type="button"
        className="capanel__btn capanel__btn--primary capanel__submit"
        onClick={() => void preview()}
        disabled={busy || files.length === 0}
      >
        {busy ? "Reading…" : "Read & review"}
      </button>

      {/* The full admin review window — categories, archetype fields, preview. */}
      {review && (
        <ComplianceIngestModal
          proposals={review.proposals}
          files={review.files}
          types={types}
          schema={schema}
          assetOptions={assetOptions}
          busy={busy}
          error={commitError}
          onCancel={() => {
            setReview(null);
            setCommitError(null);
          }}
          onConfirm={commit}
        />
      )}
    </>
  );
}

// ── 4. Add parts (inventory) ───────────────────────────────────────────────

function PartsForm({
  token,
  shipId,
}: {
  token: string | null;
  shipId: string | null | undefined;
}) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("part");
  const [partNumber, setPartNumber] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState<string>("pcs");
  const [location, setLocation] = useState("");
  const [asset, setAsset] = useState<AssetSuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);

  const submit = async () => {
    if (!token || !shipId || !name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const item = await createInventoryItem(token, shipId, {
        name: name.trim(),
        category,
        partNumber: partNumber.trim() || null,
        quantity: quantity ? Number(quantity) : null,
        unit,
        location: location.trim() || null,
        assetIds: asset ? [asset.id] : null,
      });
      setDone(item.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add the part");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Done
        text={`"${done}" added to inventory.`}
        onClose={() => {
          setDone(null);
          setName("");
          setPartNumber("");
          setQuantity("");
          setLocation("");
          setAsset(null);
        }}
      />
    );
  }

  return (
    <>
      <input
        className="capanel__input"
        placeholder="Part name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        disabled={busy}
      />
      <div className="capanel__row2">
        <div className="capanel__field">
          <span className="capanel__label">Category</span>
          <select
            className="capanel__input"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            disabled={busy}
          >
            {INVENTORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c[0].toUpperCase() + c.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div className="capanel__field">
          <span className="capanel__label">Part no.</span>
          <input
            className="capanel__input"
            placeholder="e.g. 3B7-01234"
            value={partNumber}
            onChange={(e) => setPartNumber(e.target.value)}
            disabled={busy}
          />
        </div>
      </div>
      <div className="capanel__row2">
        <div className="capanel__field">
          <span className="capanel__label">Quantity</span>
          <input
            type="number"
            className="capanel__input"
            placeholder="0"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="capanel__field">
          <span className="capanel__label">Unit</span>
          <select
            className="capanel__input"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            disabled={busy}
          >
            {INVENTORY_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="capanel__field">
        <span className="capanel__label">Location</span>
        <input
          className="capanel__input"
          placeholder="e.g. Engine store, shelf B3"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          disabled={busy}
        />
      </div>
      <div className="capanel__field">
        <span className="capanel__label">For equipment (optional)</span>
        {token && shipId && (
          <AssetPicker
            token={token}
            shipId={shipId}
            asset={asset}
            onPick={setAsset}
            onClear={() => setAsset(null)}
            disabled={busy}
          />
        )}
      </div>
      {error && <div className="capanel__error">{error}</div>}
      <button
        type="button"
        className="capanel__btn capanel__btn--primary capanel__submit"
        onClick={() => void submit()}
        disabled={busy || !name.trim()}
      >
        {busy ? "Adding…" : "Add to inventory"}
      </button>
    </>
  );
}
