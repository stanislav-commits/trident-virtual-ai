import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { PlusIcon, XIcon, TrashIcon } from "./AdminPanelIcons";
import {
  listInventory,
  createInventoryItem,
  updateInventoryItem,
  deleteInventoryItem,
  INVENTORY_CATEGORIES,
  INVENTORY_UNITS,
  previewInventoryImport,
  commitInventoryImport,
  type InventoryItem,
  type InventoryLink,
  type UpsertInventoryInput,
  type InventoryImportDraft,
  type InventoryImportPreview,
} from "../../api/inventoryApi";
import { listAssets } from "../../api/assetsApi";
import { AssetMultiSelect, type AssetOption } from "./AssetMultiSelect";
import { listPmsTasks, type PmsTaskDto } from "../../api/pmsApi";
import { useAdminShip } from "../../context/AdminShipContext";
import { useAdminEvents } from "../../hooks/admin/adminEvents";

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
  const [assetOptions, setAssetOptions] = useState<AssetOption[]>([]);
  useEffect(() => {
    if (!token) return;
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
      value={value.map((a) => a.id)}
      onChange={(ids) =>
        onChange(
          ids.map((id) => ({
            id,
            name:
              byId.get(id)?.label ??
              value.find((v) => v.id === id)?.name ??
              id,
          })),
        )
      }
    />
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
  // Stock-file import
  const [importOpen, setImportOpen] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [importErr, setImportErr] = useState("");
  const [importPreview, setImportPreview] =
    useState<InventoryImportPreview | null>(null);
  const [importFileName, setImportFileName] = useState("");

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

  // Live-sync: another admin's inventory change on this ship → re-fetch. A
  // silent reload (no spinner) so it doesn't fight this admin's own view.
  useAdminEvents("inventory", (event) => {
    if (event.shipId === shipId) void refresh();
  });

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

  const openImport = () => {
    setImportPreview(null);
    setImportErr("");
    setImportFileName("");
    setImportOpen(true);
  };

  const onImportFile = async (file: File | null) => {
    if (!file || !token || !shipId) return;
    setImportBusy(true);
    setImportErr("");
    setImportPreview(null);
    setImportFileName(file.name);
    try {
      const preview = await previewInventoryImport(token, shipId, file);
      setImportPreview(preview);
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : "Could not parse the file");
    } finally {
      setImportBusy(false);
    }
  };

  const runImport = async () => {
    if (!token || !shipId || !importPreview?.drafts.length) return;
    setImportBusy(true);
    setImportErr("");
    try {
      const drafts: InventoryImportDraft[] = importPreview.drafts.map(
        ({ existing, ...d }) => {
          void existing;
          return d;
        },
      );
      const res = await commitInventoryImport(token, shipId, drafts);
      setImportOpen(false);
      setNote(
        `Imported ${res.created} new item${res.created === 1 ? "" : "s"}` +
          (res.updated ? ` · ${res.updated} updated by part number` : ""),
      );
      await refresh();
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImportBusy(false);
    }
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
    // Optimistic: apply the edit/insert to the table instantly and close the
    // form; the create/update call runs in the background and a silent
    // refetch reconciles server-computed fields (stock min/max, value, links).
    const prev = items;
    const savingId = editId;
    if (savingId) {
      setItems((rows) =>
        rows.map((r) =>
          r.id === savingId
            ? {
                ...r,
                name: input.name,
                category: input.category ?? r.category,
                partNumber: input.partNumber ?? undefined,
                location: input.location ?? undefined,
                manufacturer: input.manufacturer ?? undefined,
                supplier: input.supplier ?? undefined,
                quantity: input.quantity ?? undefined,
                unit: input.unit ?? undefined,
                notes: input.notes ?? undefined,
                assetIds: input.assetIds ?? [],
                assets: form.assets,
                taskIds: input.taskIds ?? [],
                tasks: form.tasks,
              }
            : r,
        ),
      );
    } else {
      const optimistic: InventoryItem = {
        id: `optimistic-${crypto.randomUUID()}`,
        name: input.name,
        category: input.category ?? "",
        partNumber: input.partNumber ?? undefined,
        location: input.location ?? undefined,
        manufacturer: input.manufacturer ?? undefined,
        supplier: input.supplier ?? undefined,
        quantity: input.quantity ?? undefined,
        unit: input.unit ?? undefined,
        notes: input.notes ?? undefined,
        assetIds: input.assetIds ?? [],
        assets: form.assets,
        taskIds: input.taskIds ?? [],
        tasks: form.tasks,
      };
      setItems((rows) => [optimistic, ...rows]);
    }
    setShowForm(false);
    setNote("");
    try {
      if (savingId) await updateInventoryItem(token, shipId, savingId, input);
      else await createInventoryItem(token, shipId, input);
      void refresh();
    } catch (e) {
      setItems(prev);
      setShowForm(true);
      setNote(e instanceof Error ? e.message : "Save failed");
    }
  };

  const remove = async (i: InventoryItem) => {
    if (!token || !shipId) return;
    if (!window.confirm(`Remove "${i.name}" from inventory?`)) return;
    // Optimistic: drop the row instantly, reconcile in the background.
    const prev = items;
    setItems((rows) => rows.filter((r) => r.id !== i.id));
    setNote("");
    try {
      await deleteInventoryItem(token, shipId, i.id);
      void refresh();
    } catch (e) {
      setItems(prev);
      setNote(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const removeSelected = async () => {
    if (!token || !shipId || selected.size === 0) return;
    if (!window.confirm(`Remove ${selected.size} selected item(s) from inventory?`))
      return;
    const prev = items;
    const ids = new Set(selected);
    setItems((rows) => rows.filter((r) => !ids.has(r.id)));
    setSelected(new Set());
    setNote("");
    try {
      await Promise.all(
        Array.from(ids).map((id) => deleteInventoryItem(token, shipId, id)),
      );
      void refresh();
    } catch (e) {
      setItems(prev);
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
        <div className="inv__head-actions">
          <button type="button" className="pms__btn" onClick={openImport}>
            Import stock
          </button>
          <button
            type="button"
            className="pms__btn pms__btn--primary"
            onClick={openCreate}
          >
            <PlusIcon /> Add part
          </button>
        </div>
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

      {importOpen &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            onClick={() => !importBusy && setImportOpen(false)}
          >
            <div
              className="admin-panel__modal pms__modal pms__modal--wide"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="admin-panel__modal-header">
                <h3>Import stock</h3>
                <button
                  type="button"
                  className="admin-panel__icon-btn"
                  onClick={() => !importBusy && setImportOpen(false)}
                >
                  <XIcon />
                </button>
              </div>
              <div className="admin-panel__modal-form">
                <p className="inv__import-intro">
                  Upload another PMS's stock export (PDF, Excel or CSV). It's
                  reformatted into the Trident standard for review. Items whose
                  part number already exists are <strong>updated</strong>, not
                  duplicated.
                </p>

                {!importPreview && (
                  <label className="inv__import-drop">
                    <input
                      type="file"
                      accept=".pdf,.xlsx,.xls,.csv,.txt"
                      hidden
                      disabled={importBusy}
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        // Clear the value so re-picking the SAME file after an
                        // error still fires onChange.
                        e.target.value = "";
                        void onImportFile(f);
                      }}
                    />
                    {importBusy ? (
                      <span>Parsing {importFileName}…</span>
                    ) : (
                      <span>
                        <strong>Choose a file</strong> to parse
                        {importFileName ? ` · ${importFileName}` : ""}
                      </span>
                    )}
                  </label>
                )}

                {importErr && (
                  <div className="pms__import-error">{importErr}</div>
                )}

                {importPreview && (
                  <>
                    <div className="inv__import-summary">
                      {importPreview.counts.parsed} items ·{" "}
                      {importPreview.counts.withPartNo} with part no ·{" "}
                      {importPreview.counts.existing} already on board ·{" "}
                      {importPreview.counts.groups} groups
                    </div>
                    {importPreview.notes.map((n, idx) => (
                      <div key={idx} className="pms__import-note">
                        {n}
                      </div>
                    ))}
                    <div className="inv__import-preview-wrap">
                      <table className="inv__table inv__import-preview">
                        <thead>
                          <tr>
                            <th>Item</th>
                            <th>Part no</th>
                            <th>Qty</th>
                            <th>Min/Max</th>
                            <th>Location</th>
                            <th>Group</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {importPreview.drafts.map((d, idx) => (
                            <tr key={idx}>
                              <td className="inv__name">
                                {d.name}
                                {d.manufacturer ? (
                                  <span className="inv__import-sub">
                                    {d.manufacturer}
                                  </span>
                                ) : null}
                              </td>
                              <td className="inv__mono">
                                {d.partNumber ?? "—"}
                              </td>
                              <td>{d.quantity ?? "—"}</td>
                              <td className="inv__mono">
                                {d.stockMin ?? "—"}/{d.stockMax ?? "—"}
                              </td>
                              <td>{d.location ?? "—"}</td>
                              <td>{d.assetGroup ?? "—"}</td>
                              <td>
                                {d.existing ? (
                                  <span className="inv__import-badge inv__import-badge--upd">
                                    update
                                  </span>
                                ) : (
                                  <span className="inv__import-badge inv__import-badge--new">
                                    new
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="pms__btn"
                  onClick={() => setImportOpen(false)}
                  disabled={importBusy}
                >
                  Cancel
                </button>
                {importPreview && (
                  <button
                    type="button"
                    className="pms__btn pms__btn--primary"
                    onClick={() => void runImport()}
                    disabled={importBusy || !importPreview.drafts.length}
                  >
                    {importBusy
                      ? "Importing…"
                      : `Import ${importPreview.drafts.length} items`}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}

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
