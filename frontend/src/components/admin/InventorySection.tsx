import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PlusIcon, XIcon, TrashIcon } from "./AdminPanelIcons";
import {
  listInventory,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  INVENTORY_CATEGORIES,
  INVENTORY_UNITS,
  type InventoryItem,
  type InventoryLink,
  type UpsertInventoryInput,
} from "../../api/inventoryApi";
import { listAssets, type AssetItem } from "../../api/assetsApi";
import { listPmsTasks, type PmsTaskDto } from "../../api/pmsApi";
import { useAdminShip } from "../../context/AdminShipContext";

interface InventorySectionProps {
  token: string | null;
}

const EMPTY: Omit<UpsertInventoryInput, "assetIds" | "taskIds"> & {
  assets: InventoryLink[];
  tasks: InventoryLink[];
} = {
  name: "",
  category: "part",
  partNumber: "",
  location: "",
  manufacturer: "",
  supplier: "",
  quantity: null,
  unit: "",
  assets: [],
  tasks: [],
  notes: "",
};

/**
 * Server-side searchable multi-asset picker — never loads the full asset list.
 * An inventory item can be linked to several assets; selected ones show as
 * removable chips and the popup stays open so you can add more.
 */
function MultiAssetPicker({
  token,
  shipId,
  value,
  onChange,
}: {
  token: string | null;
  shipId: string;
  value: InventoryLink[];
  onChange: (next: InventoryLink[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const selectedIds = new Set(value.map((a) => a.id));

  useEffect(() => {
    if (!open || !token) return;
    let alive = true;
    const t = setTimeout(() => {
      setLoading(true);
      listAssets(token, shipId, {
        search: query.trim() || undefined,
        limit: 25,
      })
        .then((r) => alive && setResults(r.items))
        .catch(() => alive && setResults([]))
        .finally(() => alive && setLoading(false));
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, query, token, shipId]);

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

  const toggle = (a: AssetItem) => {
    if (selectedIds.has(a.id)) {
      onChange(value.filter((v) => v.id !== a.id));
    } else {
      onChange([...value, { id: a.id, name: a.displayName }]);
    }
  };
  const removeChip = (id: string) => onChange(value.filter((v) => v.id !== id));

  return (
    <div className="inv__picker" ref={boxRef}>
      {value.length > 0 && (
        <div className="inv__chips">
          {value.map((a) => (
            <span key={a.id} className="inv__chip">
              {a.name}
              <button
                type="button"
                className="inv__chip-x"
                onClick={() => removeChip(a.id)}
                aria-label={`Unlink ${a.name}`}
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
            ? `${value.length} asset${value.length === 1 ? "" : "s"} linked`
            : "— none —"}
        </span>
        <span className="inv__picker-caret">＋</span>
      </button>
      {open && (
        <div className="inv__picker-pop">
          <input
            type="search"
            className="admin-panel__input admin-panel__input--full"
            placeholder="Search asset by name or tag…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="inv__picker-list">
            {loading && <div className="inv__picker-hint">Searching…</div>}
            {!loading && results.length === 0 && (
              <div className="inv__picker-hint">No matches</div>
            )}
            {results.map((a) => {
              const on = selectedIds.has(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`inv__picker-opt${on ? " inv__picker-opt--active" : ""}`}
                  onClick={() => toggle(a)}
                >
                  <span>
                    <input type="checkbox" checked={on} readOnly /> {a.displayName}
                  </span>
                  <span className="inv__mono inv__muted">{a.assetIdInternal}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Chips + add-dropdown multi-select bound to the ship's PMS task list. */
function TaskMultiSelect({
  tasks,
  value,
  onChange,
}: {
  tasks: PmsTaskDto[];
  value: InventoryLink[];
  onChange: (next: InventoryLink[]) => void;
}) {
  const selectedIds = new Set(value.map((t) => t.id));
  const available = tasks.filter((t) => !selectedIds.has(t.id));
  return (
    <div className="inv__picker">
      {value.length > 0 && (
        <div className="inv__chips">
          {value.map((t) => (
            <span key={t.id} className="inv__chip">
              {t.name}
              <button
                type="button"
                className="inv__chip-x"
                onClick={() => onChange(value.filter((v) => v.id !== t.id))}
                aria-label={`Unlink ${t.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <select
        className="admin-panel__input"
        value=""
        onChange={(e) => {
          const t = tasks.find((x) => x.id === e.target.value);
          if (t) onChange([...value, { id: t.id, name: t.task }]);
        }}
      >
        <option value="">
          {available.length ? "+ link a task…" : "— no more tasks —"}
        </option>
        {available.map((t) => (
          <option key={t.id} value={t.id}>
            {t.task}
          </option>
        ))}
      </select>
    </div>
  );
}

export function InventorySection({ token }: InventorySectionProps) {
  const { selectedShipId: shipId } = useAdminShip();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [tasks, setTasks] = useState<PmsTaskDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [catFilter, setCatFilter] = useState<string>("all");
  const [locFilter, setLocFilter] = useState<string>("all");
  const [mfrFilter, setMfrFilter] = useState<string>("all");
  const [supFilter, setSupFilter] = useState<string>("all");
  const [assetFilter, setAssetFilter] = useState<string>("all");
  const [taskFilter, setTaskFilter] = useState<string>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY });

  const refresh = useCallback(async () => {
    if (!token || !shipId) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      setItems(await listInventory(token, shipId));
      setSelected(new Set());
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Failed to load inventory");
    } finally {
      setLoading(false);
    }
  }, [token, shipId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Tasks are bounded per vessel — fine to preload for the modal select.
  // Assets are NOT preloaded (could be thousands) — the modal uses AssetPicker.
  useEffect(() => {
    if (!token || !shipId) return;
    let alive = true;
    void listPmsTasks(token, shipId)
      .then((t) => alive && setTasks(t))
      .catch(() => alive && setTasks([]));
    return () => {
      alive = false;
    };
  }, [token, shipId]);

  // Distinct values present in the current items, for the filter dropdowns.
  const distinct = useMemo(() => {
    const uniq = (vals: (string | null | undefined)[]) =>
      Array.from(new Set(vals.filter((v): v is string => !!v && !!v.trim()))).sort(
        (a, b) => a.localeCompare(b),
      );
    return {
      locations: uniq(items.map((i) => i.location)),
      manufacturers: uniq(items.map((i) => i.manufacturer)),
      suppliers: uniq(items.map((i) => i.supplier)),
      assets: uniq(items.flatMap((i) => i.assets.map((a) => a.name))),
      tasks: uniq(items.flatMap((i) => i.tasks.map((t) => t.name))),
    };
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (catFilter !== "all" && i.category !== catFilter) return false;
      if (locFilter !== "all" && i.location !== locFilter) return false;
      if (mfrFilter !== "all" && i.manufacturer !== mfrFilter) return false;
      if (supFilter !== "all" && i.supplier !== supFilter) return false;
      if (
        assetFilter !== "all" &&
        !i.assets.some((a) => a.name === assetFilter)
      )
        return false;
      if (
        taskFilter !== "all" &&
        !i.tasks.some((t) => t.name === taskFilter)
      )
        return false;
      if (!q) return true;
      return [
        i.name,
        i.partNumber,
        i.manufacturer,
        i.supplier,
        i.location,
        ...i.assets.map((a) => a.name),
        ...i.tasks.map((t) => t.name),
      ]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q));
    });
  }, [items, search, catFilter, locFilter, mfrFilter, supFilter, assetFilter, taskFilter]);

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((i) => selected.has(i.id));
  const toggleAll = () => {
    setSelected((prev) => {
      if (filtered.every((i) => prev.has(i.id))) {
        const next = new Set(prev);
        filtered.forEach((i) => next.delete(i.id));
        return next;
      }
      const next = new Set(prev);
      filtered.forEach((i) => next.add(i.id));
      return next;
    });
  };
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const openCreate = () => {
    setEditId(null);
    setForm({ ...EMPTY });
    setNote("");
    setShowForm(true);
  };
  const openEdit = (i: InventoryItem) => {
    setEditId(i.id);
    setForm({
      name: i.name,
      category: i.category,
      partNumber: i.partNumber ?? "",
      location: i.location ?? "",
      manufacturer: i.manufacturer ?? "",
      supplier: i.supplier ?? "",
      quantity: i.quantity ?? null,
      unit: i.unit ?? "",
      assets: i.assets ?? [],
      tasks: i.tasks ?? [],
      notes: i.notes ?? "",
    });
    setNote("");
    setShowForm(true);
  };

  const submit = async () => {
    if (!token || !shipId || !form.name.trim()) return;
    const input: UpsertInventoryInput = {
      name: form.name,
      category: form.category,
      partNumber: form.partNumber,
      location: form.location,
      manufacturer: form.manufacturer,
      supplier: form.supplier,
      unit: form.unit,
      notes: form.notes,
      quantity:
        form.quantity === null ||
        form.quantity === undefined ||
        (form.quantity as unknown) === ""
          ? null
          : Number(form.quantity),
      assetIds: form.assets.map((a) => a.id),
      taskIds: form.tasks.map((t) => t.id),
    };
    try {
      if (editId) await updateInventoryItem(token, shipId, editId, input);
      else await createInventoryItem(token, shipId, input);
      setShowForm(false);
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Save failed");
    }
  };

  const remove = async (i: InventoryItem) => {
    if (!token || !shipId) return;
    if (!window.confirm(`Remove "${i.name}" from inventory?`)) return;
    try {
      await deleteInventoryItem(token, shipId, i.id);
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const removeSelected = async () => {
    if (!token || !shipId || selected.size === 0) return;
    if (!window.confirm(`Remove ${selected.size} selected item(s) from inventory?`))
      return;
    try {
      await Promise.all(
        Array.from(selected).map((id) => deleteInventoryItem(token, shipId, id)),
      );
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Bulk delete failed");
    }
  };

  if (!shipId) {
    return (
      <div className="inv">
        <p className="inv__empty">Select a vessel to manage its inventory.</p>
      </div>
    );
  }

  // Keep a unit not in the canonical list (legacy / AI-suggested) selectable.
  const unitOptions =
    form.unit && !INVENTORY_UNITS.includes(form.unit as never)
      ? [form.unit, ...INVENTORY_UNITS]
      : [...INVENTORY_UNITS];

  return (
    <div className="inv">
      <div className="inv__head">
        <div>
          <h2 className="inv__title">Inventory</h2>
          <p className="inv__sub">
            {items.length} items · spare parts, tools, fluids
          </p>
        </div>
        <button
          type="button"
          className="pms__btn pms__btn--primary"
          onClick={openCreate}
        >
          <PlusIcon /> Add part
        </button>
      </div>

      <div className="inv__toolbar">
        <input
          type="search"
          className="pms__search"
          placeholder="Search name, number, maker, supplier, asset…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {selected.size > 0 && (
        <div className="inv__bulkbar">
          <span>{selected.size} selected</span>
          <button
            type="button"
            className="pms__btn inv__bulk-delete"
            onClick={() => void removeSelected()}
          >
            <TrashIcon /> Delete selected
          </button>
          <button
            type="button"
            className="pms__btn"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </button>
        </div>
      )}

      {note && <div className="pms__import-note">{note}</div>}

      <div className="inv__table-wrap">
        <table className="inv__table">
          <thead>
            <tr>
              <th className="inv__check-col">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th>Name</th>
              <th>Number</th>
              <th>
                <select
                  className="admin-panel__th-filter"
                  value={catFilter}
                  onChange={(e) => setCatFilter(e.target.value)}
                  aria-label="Filter by category"
                >
                  <option value="all">Cat.</option>
                  {INVENTORY_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </th>
              <th>Qty</th>
              <th>
                <select
                  className="admin-panel__th-filter"
                  value={locFilter}
                  onChange={(e) => setLocFilter(e.target.value)}
                  aria-label="Filter by location"
                >
                  <option value="all">Location</option>
                  {distinct.locations.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </th>
              <th>
                <select
                  className="admin-panel__th-filter"
                  value={mfrFilter}
                  onChange={(e) => setMfrFilter(e.target.value)}
                  aria-label="Filter by manufacturer"
                >
                  <option value="all">Manufacturer</option>
                  {distinct.manufacturers.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </th>
              <th>
                <select
                  className="admin-panel__th-filter"
                  value={supFilter}
                  onChange={(e) => setSupFilter(e.target.value)}
                  aria-label="Filter by supplier"
                >
                  <option value="all">Supplier</option>
                  {distinct.suppliers.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </th>
              <th>
                <select
                  className="admin-panel__th-filter"
                  value={assetFilter}
                  onChange={(e) => setAssetFilter(e.target.value)}
                  aria-label="Filter by asset"
                >
                  <option value="all">Asset</option>
                  {distinct.assets.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </th>
              <th>
                <select
                  className="admin-panel__th-filter"
                  value={taskFilter}
                  onChange={(e) => setTaskFilter(e.target.value)}
                  aria-label="Filter by task"
                >
                  <option value="all">Task</option>
                  {distinct.tasks.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && !loading && (
              <tr>
                <td colSpan={11} className="inv__empty-cell">
                  No items. Add a part, or use “Suggest from manual” on an asset.
                </td>
              </tr>
            )}
            {filtered.map((i) => (
              <tr
                key={i.id}
                onClick={() => openEdit(i)}
                className={`inv__row${selected.has(i.id) ? " inv__row--selected" : ""}`}
              >
                <td
                  className="inv__check-col"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(i.id)}
                    onChange={() => toggleOne(i.id)}
                    aria-label={`Select ${i.name}`}
                  />
                </td>
                <td className="inv__name">{i.name}</td>
                <td className="inv__mono">{i.partNumber ?? "—"}</td>
                <td>
                  <span className="inv__cat">{i.category}</span>
                </td>
                <td>
                  {i.quantity != null
                    ? `${i.quantity}${i.unit ? " " + i.unit : ""}`
                    : "—"}
                </td>
                <td>{i.location ?? "—"}</td>
                <td>{i.manufacturer ?? "—"}</td>
                <td>{i.supplier ?? "—"}</td>
                <td>
                  {i.assets.length === 0 ? (
                    "—"
                  ) : i.assets.length === 1 ? (
                    i.assets[0].name
                  ) : (
                    <span
                      title={i.assets.map((a) => a.name).join(", ")}
                      className="inv__asset-multi"
                    >
                      {i.assets[0].name}
                      <span className="inv__asset-more">
                        +{i.assets.length - 1}
                      </span>
                    </span>
                  )}
                </td>
                <td className="inv__muted">
                  {i.tasks.length === 0 ? (
                    "—"
                  ) : i.tasks.length === 1 ? (
                    i.tasks[0].name
                  ) : (
                    <span
                      title={i.tasks.map((t) => t.name).join(", ")}
                      className="inv__asset-multi"
                    >
                      {i.tasks[0].name}
                      <span className="inv__asset-more">
                        +{i.tasks.length - 1}
                      </span>
                    </span>
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="inv__del-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      void remove(i);
                    }}
                    title="Remove"
                  >
                    <TrashIcon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showForm &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            onClick={() => setShowForm(false)}
          >
            <div
              className="admin-panel__modal pms__modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="admin-panel__modal-header">
                <h3>{editId ? "Edit item" : "Add part"}</h3>
                <button
                  type="button"
                  className="admin-panel__icon-btn"
                  onClick={() => setShowForm(false)}
                >
                  <XIcon />
                </button>
              </div>
              <div className="admin-panel__modal-form">
                <div className="admin-panel__modal-field">
                  <label className="admin-panel__field-label">Name</label>
                  <input
                    className="admin-panel__input admin-panel__input--full"
                    value={form.name}
                    autoFocus
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. Fuel filter element"
                  />
                </div>
                <div className="inv__form-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Category</label>
                    <select
                      className="admin-panel__input"
                      value={form.category}
                      onChange={(e) =>
                        setForm({ ...form, category: e.target.value })
                      }
                    >
                      {INVENTORY_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Part number
                    </label>
                    <input
                      className="admin-panel__input"
                      value={form.partNumber ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, partNumber: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="inv__form-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Quantity</label>
                    <input
                      className="admin-panel__input"
                      inputMode="decimal"
                      value={form.quantity ?? ""}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          quantity:
                            e.target.value === ""
                              ? null
                              : (e.target.value as unknown as number),
                        })
                      }
                    />
                  </div>
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Unit</label>
                    <select
                      className="admin-panel__input"
                      value={form.unit ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, unit: e.target.value })
                      }
                    >
                      <option value="">—</option>
                      {unitOptions.map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Location</label>
                    <input
                      className="admin-panel__input"
                      value={form.location ?? ""}
                      placeholder="store / locker"
                      onChange={(e) =>
                        setForm({ ...form, location: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="inv__form-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Manufacturer
                    </label>
                    <input
                      className="admin-panel__input"
                      value={form.manufacturer ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, manufacturer: e.target.value })
                      }
                    />
                  </div>
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">Supplier</label>
                    <input
                      className="admin-panel__input"
                      value={form.supplier ?? ""}
                      onChange={(e) =>
                        setForm({ ...form, supplier: e.target.value })
                      }
                    />
                  </div>
                </div>
                <div className="inv__form-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Linked assets
                    </label>
                    <MultiAssetPicker
                      token={token}
                      shipId={shipId}
                      value={form.assets}
                      onChange={(next) => setForm({ ...form, assets: next })}
                    />
                  </div>
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Linked tasks
                    </label>
                    <TaskMultiSelect
                      tasks={tasks}
                      value={form.tasks}
                      onChange={(next) => setForm({ ...form, tasks: next })}
                    />
                  </div>
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
                    type="button"
                    className="admin-panel__btn admin-panel__btn--primary"
                    disabled={!form.name.trim()}
                    onClick={() => void submit()}
                  >
                    {editId ? "Save changes" : "Add part"}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
