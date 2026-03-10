import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  createShip,
  updateShip,
  deleteShip,
  uploadManual,
  type ShipListItem,
  type MetricDefinitionItem,
  type UserListItem,
} from "../../api/client";
import {
  ShipIcon,
  XIcon,
  PlusIcon,
  ChevronDownIcon,
  SearchIcon,
  UploadIcon,
} from "./AdminPanelIcons";

/* ── Compact multi-select picker ── */
interface PickerOption {
  key: string;
  label: string;
  extra?: string;
}

function MultiSelectPicker({
  options,
  selected,
  onToggle,
  onSelectAll,
  onDeselectAll,
  disabled,
  placeholder = "Select…",
}: {
  options: PickerOption[];
  selected: string[];
  onToggle: (key: string) => void;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = options.filter((o) =>
    o.label.toLowerCase().includes(search.toLowerCase()),
  );

  const selectedItems = options.filter((o) => selected.includes(o.key));

  return (
    <div className="admin-panel__picker" ref={wrapRef}>
      <button
        type="button"
        className="admin-panel__picker-trigger"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
      >
        {selected.length === 0 ? (
          <span className="admin-panel__picker-placeholder">{placeholder}</span>
        ) : (
          <span className="admin-panel__picker-summary">
            {selected.length} selected
          </span>
        )}
        <ChevronDownIcon open={open} />
      </button>

      {open && (
        <div className="admin-panel__picker-panel">
          <div className="admin-panel__picker-search-wrap">
            <SearchIcon />
            <input
              type="text"
              className="admin-panel__picker-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              autoFocus
            />
          </div>
          {(onSelectAll || onDeselectAll) && (
            <div className="admin-panel__picker-actions">
              {onSelectAll && (
                <button
                  type="button"
                  className="admin-panel__picker-action-btn"
                  onClick={onSelectAll}
                  disabled={disabled}
                >
                  Select all
                </button>
              )}
              {onDeselectAll && selected.length > 0 && (
                <button
                  type="button"
                  className="admin-panel__picker-action-btn"
                  onClick={onDeselectAll}
                  disabled={disabled}
                >
                  Deselect all
                </button>
              )}
            </div>
          )}
          <div className="admin-panel__picker-list">
            {filtered.length === 0 ? (
              <div className="admin-panel__picker-empty">No results</div>
            ) : (
              filtered.map((opt) => (
                <label key={opt.key} className="admin-panel__picker-option">
                  <input
                    type="checkbox"
                    className="admin-panel__picker-check"
                    checked={selected.includes(opt.key)}
                    onChange={() => onToggle(opt.key)}
                  />
                  <span className="admin-panel__picker-option-label">
                    {opt.label}
                  </span>
                  {opt.extra && (
                    <span className="admin-panel__picker-option-extra">
                      {opt.extra}
                    </span>
                  )}
                </label>
              ))
            )}
          </div>
        </div>
      )}

      {selectedItems.length > 0 && (
        <div className="admin-panel__picker-chips">
          {selectedItems.map((item) => (
            <span key={item.key} className="admin-panel__picker-chip">
              <span className="admin-panel__picker-chip-text">
                {item.label}
              </span>
              <button
                type="button"
                className="admin-panel__picker-chip-x"
                onClick={() => onToggle(item.key)}
                disabled={disabled}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface ShipsSectionProps {
  token: string | null;
  ships: ShipListItem[];
  users: UserListItem[];
  metricDefinitions: MetricDefinitionItem[];
  loading: boolean;
  error: string;
  onLoadShips: () => Promise<void>;
  onError: (error: string) => void;
  onShipCreated?(shipId: string, shipName: string): void;
  onOpenManuals?: (shipId: string, shipName: string) => void;
  onOpenMetrics?: (ship: ShipListItem) => void;
}

interface ShipForm {
  name: string;
  serialNumber: string;
  metricKeys: string[];
  userIds: string[];
}

interface DeleteConfirm {
  id: string;
  name: string;
}

export function ShipsSection({
  token,
  ships,
  users,
  metricDefinitions,
  loading,
  onLoadShips,
  onError,
  onOpenManuals,
  onOpenMetrics,
}: ShipsSectionProps) {
  const [shipForm, setShipForm] = useState<ShipForm>({
    name: "",
    serialNumber: "",
    metricKeys: [],
    userIds: [],
  });
  const [showFormModal, setShowFormModal] = useState(false);
  const [creatingShip, setCreatingShip] = useState(false);
  const [editingShipId, setEditingShipId] = useState<string | null>(null);
  const [deletingShipId, setDeletingShipId] = useState<string | null>(null);
  const [shipDeleteConfirm, setShipDeleteConfirm] =
    useState<DeleteConfirm | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const toggleMetricKey = (key: string) => {
    setShipForm((prev) => ({
      ...prev,
      metricKeys: prev.metricKeys.includes(key)
        ? prev.metricKeys.filter((k) => k !== key)
        : [...prev.metricKeys, key],
    }));
  };

  const toggleShipUserId = (id: string) => {
    setShipForm((prev) => ({
      ...prev,
      userIds: prev.userIds.includes(id)
        ? prev.userIds.filter((x) => x !== id)
        : [...prev.userIds, id],
    }));
  };

  const openCreateModal = () => {
    setEditingShipId(null);
    setShipForm({ name: "", serialNumber: "", metricKeys: [], userIds: [] });
    setPendingFiles([]);
    setShowFormModal(true);
  };

  const closeFormModal = () => {
    if (creatingShip) return;
    setShowFormModal(false);
    setEditingShipId(null);
    setShipForm({ name: "", serialNumber: "", metricKeys: [], userIds: [] });
    setPendingFiles([]);
  };

  const handleShipEdit = (ship: ShipListItem) => {
    setEditingShipId(ship.id);
    setShipForm({
      name: ship.name,
      serialNumber: ship.serialNumber ?? "",
      metricKeys: ship.metricsConfig.map((c) => c.metricKey),
      userIds: (ship.assignedUsers ?? []).map((u) => u.id),
    });
    setShowFormModal(true);
  };

  const handleShipEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !editingShipId || !shipForm.name.trim()) return;
    setCreatingShip(true);
    onError("");
    try {
      await updateShip(
        editingShipId,
        {
          name: shipForm.name.trim(),
          serialNumber: shipForm.serialNumber.trim() || null,
          metricKeys: shipForm.metricKeys,
          userIds: shipForm.userIds,
        },
        token,
      );
      setEditingShipId(null);
      setShowFormModal(false);
      setShipForm({ name: "", serialNumber: "", metricKeys: [], userIds: [] });
      await onLoadShips();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to update ship");
    } finally {
      setCreatingShip(false);
    }
  };

  const handleShipDeleteClick = (id: string, name: string) =>
    setShipDeleteConfirm({ id, name });
  const handleShipDeleteCancel = () => setShipDeleteConfirm(null);

  const handleShipDeleteConfirm = async () => {
    if (!token || !shipDeleteConfirm) return;
    setDeletingShipId(shipDeleteConfirm.id);
    onError("");
    setShipDeleteConfirm(null);
    try {
      await deleteShip(shipDeleteConfirm.id, token);
      await onLoadShips();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to delete ship");
    } finally {
      setDeletingShipId(null);
    }
  };

  const handleShipCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !shipForm.name.trim()) return;
    setCreatingShip(true);
    onError("");
    try {
      const created = await createShip(
        {
          name: shipForm.name.trim(),
          serialNumber: shipForm.serialNumber.trim() || undefined,
          metricKeys: shipForm.metricKeys,
          userIds: shipForm.userIds.length ? shipForm.userIds : undefined,
        },
        token,
      );
      // Upload queued manuals
      if (pendingFiles.length > 0) {
        const uploadErrors: string[] = [];
        for (const file of pendingFiles) {
          try {
            await uploadManual(created.id, file, token);
          } catch (err) {
            uploadErrors.push(
              `${file.name}: ${err instanceof Error ? err.message : "upload failed"}`,
            );
          }
        }
        if (uploadErrors.length) {
          onError(
            `Ship created but manual upload failed: ${uploadErrors.join("; ")}`,
          );
        }
      }
      setShipForm({ name: "", serialNumber: "", metricKeys: [], userIds: [] });
      setPendingFiles([]);
      setShowFormModal(false);
      await onLoadShips();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Failed to create ship");
    } finally {
      setCreatingShip(false);
    }
  };

  return (
    <>
      <section className="admin-panel__section">
        <div className="admin-panel__section-head">
          <div>
            <h2 className="admin-panel__section-title">Ships</h2>
            <p className="admin-panel__section-subtitle">
              Create and manage ships and their metrics.
            </p>
          </div>
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--primary"
            onClick={openCreateModal}
          >
            <PlusIcon /> Add ship
          </button>
        </div>

        {loading ? (
          <div className="admin-panel__state-box">
            <div className="admin-panel__spinner" />
            <span className="admin-panel__muted">Loading ships…</span>
          </div>
        ) : ships.length === 0 ? (
          <div className="admin-panel__state-box">
            <ShipIcon />
            <span className="admin-panel__muted">No ships yet.</span>
          </div>
        ) : (
          <div className="admin-panel__card">
            <table className="admin-panel__table">
              <thead>
                <tr>
                  <th className="admin-panel__th">Name</th>
                  <th className="admin-panel__th">Serial</th>
                  <th className="admin-panel__th">Metrics</th>
                  <th className="admin-panel__th">Users</th>
                  <th className="admin-panel__th">Actions</th>
                </tr>
              </thead>
              <tbody>
                {ships.map((ship) => (
                  <tr key={ship.id} className="admin-panel__row">
                    <td className="admin-panel__td admin-panel__td--name">
                      {ship.name}
                    </td>
                    <td className="admin-panel__td admin-panel__td--serial">
                      {ship.serialNumber ?? "—"}
                    </td>
                    <td className="admin-panel__td admin-panel__td--metrics">
                      {ship.metricsConfig.length ? (
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--ghost"
                          onClick={() => onOpenMetrics?.(ship)}
                        >
                          Metrics
                          <span className="admin-panel__count-badge">
                            {ship.metricsConfig.length}
                          </span>
                        </button>
                      ) : (
                        <span className="admin-panel__muted">—</span>
                      )}
                    </td>
                    <td className="admin-panel__td admin-panel__td--metrics">
                      {(ship.assignedUsers?.length ?? 0) > 0 ? (
                        <div className="admin-panel__metric-tags">
                          {(ship.assignedUsers ?? []).map((u) => (
                            <span
                              key={u.id}
                              className="admin-panel__metric-tag"
                            >
                              {u.name?.trim() || u.userId}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="admin-panel__muted">—</span>
                      )}
                    </td>
                    <td className="admin-panel__td">
                      <div className="admin-panel__actions">
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--ghost"
                          onClick={() => onOpenManuals?.(ship.id, ship.name)}
                          disabled={deletingShipId === ship.id}
                        >
                          Manuals
                        </button>
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--ghost"
                          onClick={() => handleShipEdit(ship)}
                          disabled={deletingShipId === ship.id}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--danger"
                          onClick={() =>
                            handleShipDeleteClick(ship.id, ship.name)
                          }
                          disabled={deletingShipId === ship.id}
                        >
                          {deletingShipId === ship.id ? "…" : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Create / Edit ship modal ── */}
      {showFormModal &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-ship-form-title"
            onClick={(e) => {
              if (e.target === e.currentTarget) closeFormModal();
            }}
          >
            <div className="admin-panel__modal admin-panel__modal--large">
              <button
                type="button"
                className="admin-panel__modal-close"
                onClick={closeFormModal}
                aria-label="Close"
              >
                <XIcon />
              </button>
              <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
                <ShipIcon />
              </div>
              <h2 id="ap-ship-form-title" className="admin-panel__modal-title">
                {editingShipId ? "Edit ship" : "Create new ship"}
              </h2>
              <p className="admin-panel__modal-desc">
                {editingShipId
                  ? "Update ship details, metrics and user assignments."
                  : "Set up a new ship with its metrics and crew."}
              </p>
              <form
                onSubmit={
                  editingShipId ? handleShipEditSubmit : handleShipCreate
                }
                className="admin-panel__modal-form"
              >
                <div className="admin-panel__modal-field-row">
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Ship name
                    </label>
                    <input
                      type="text"
                      className="admin-panel__input admin-panel__input--full"
                      value={shipForm.name}
                      onChange={(e) =>
                        setShipForm((p) => ({ ...p, name: e.target.value }))
                      }
                      placeholder="e.g. Ocean Explorer"
                      required
                      disabled={creatingShip}
                      autoFocus
                    />
                  </div>
                  <div className="admin-panel__modal-field">
                    <label className="admin-panel__field-label">
                      Serial number
                    </label>
                    <input
                      type="text"
                      className="admin-panel__input admin-panel__input--full"
                      value={shipForm.serialNumber}
                      onChange={(e) =>
                        setShipForm((p) => ({
                          ...p,
                          serialNumber: e.target.value,
                        }))
                      }
                      placeholder="Optional"
                      disabled={creatingShip}
                    />
                  </div>
                </div>
                {metricDefinitions.length > 0 && (
                  <div className="admin-panel__modal-field">
                    <span className="admin-panel__field-label">Metrics</span>
                    <MultiSelectPicker
                      options={metricDefinitions.map((m) => ({
                        key: m.key,
                        label: m.label,
                        extra: m.unit || undefined,
                      }))}
                      selected={shipForm.metricKeys}
                      onToggle={toggleMetricKey}
                      onSelectAll={() =>
                        setShipForm((p) => ({
                          ...p,
                          metricKeys: metricDefinitions.map((m) => m.key),
                        }))
                      }
                      onDeselectAll={() =>
                        setShipForm((p) => ({ ...p, metricKeys: [] }))
                      }
                      disabled={creatingShip}
                      placeholder="Choose metrics…"
                    />
                  </div>
                )}
                {users.filter(
                  (u) =>
                    u.role === "user" &&
                    (u.shipId == null || u.shipId === editingShipId),
                ).length > 0 && (
                  <div className="admin-panel__modal-field">
                    <span className="admin-panel__field-label">
                      Assigned users
                    </span>
                    <MultiSelectPicker
                      options={users
                        .filter(
                          (u) =>
                            u.role === "user" &&
                            (u.shipId == null || u.shipId === editingShipId),
                        )
                        .map((u) => ({
                          key: u.id,
                          label: u.name?.trim() || u.userId,
                        }))}
                      selected={shipForm.userIds}
                      onToggle={toggleShipUserId}
                      disabled={creatingShip}
                      placeholder="Assign users…"
                    />
                  </div>
                )}
                {/* ── Manuals dropzone (create mode only) ── */}
                {!editingShipId && (
                  <div className="admin-panel__modal-field">
                    <span className="admin-panel__field-label">Manuals</span>
                    <div
                      className={`admin-panel__dropzone${
                        creatingShip ? " admin-panel__dropzone--disabled" : ""
                      }`}
                      onClick={() =>
                        !creatingShip && fileInputRef.current?.click()
                      }
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.currentTarget.classList.add(
                          "admin-panel__dropzone--active",
                        );
                      }}
                      onDragLeave={(e) =>
                        e.currentTarget.classList.remove(
                          "admin-panel__dropzone--active",
                        )
                      }
                      onDrop={(e) => {
                        e.preventDefault();
                        e.currentTarget.classList.remove(
                          "admin-panel__dropzone--active",
                        );
                        if (creatingShip) return;
                        const dropped = Array.from(e.dataTransfer.files).filter(
                          (f) => /\.(pdf|doc|docx|txt)$/i.test(f.name),
                        );
                        if (dropped.length)
                          setPendingFiles((prev) => [...prev, ...dropped]);
                      }}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept=".pdf,.doc,.docx,.txt,.md,.csv,.jpg,.jpeg,.png,.bmp,.svg"
                        className="admin-panel__dropzone-input"
                        onChange={(e) => {
                          const files = Array.from(e.target.files ?? []);
                          if (files.length)
                            setPendingFiles((prev) => [...prev, ...files]);
                          e.target.value = "";
                        }}
                      />
                      <UploadIcon />
                      <span className="admin-panel__dropzone-text">
                        Drop files here or{" "}
                        <span className="admin-panel__dropzone-link">
                          browse
                        </span>
                      </span>
                      <span className="admin-panel__dropzone-hint">
                        PDF, DOC, DOCX, TXT
                      </span>
                    </div>
                    {pendingFiles.length > 0 && (
                      <div className="admin-panel__dropzone-files">
                        {pendingFiles.map((f, i) => (
                          <span
                            key={`${f.name}-${i}`}
                            className="admin-panel__picker-chip"
                          >
                            <span className="admin-panel__picker-chip-text">
                              {f.name}
                            </span>
                            <button
                              type="button"
                              className="admin-panel__picker-chip-x"
                              onClick={() =>
                                setPendingFiles((prev) =>
                                  prev.filter((_, idx) => idx !== i),
                                )
                              }
                              disabled={creatingShip}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="admin-panel__modal-actions">
                  <button
                    type="button"
                    className="admin-panel__btn admin-panel__btn--ghost"
                    onClick={closeFormModal}
                    disabled={creatingShip}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="admin-panel__btn admin-panel__btn--primary"
                    disabled={creatingShip || !shipForm.name.trim()}
                  >
                    {creatingShip
                      ? "Saving…"
                      : editingShipId
                        ? "Save changes"
                        : "Create ship"}
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {shipDeleteConfirm &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-ship-delete-title"
          >
            <div className="admin-panel__modal">
              <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
                <XIcon />
              </div>
              <h2
                id="ap-ship-delete-title"
                className="admin-panel__modal-title"
              >
                Delete this ship?
              </h2>
              <p className="admin-panel__modal-desc">
                Ship{" "}
                <code className="admin-panel__code">
                  {shipDeleteConfirm.name}
                </code>{" "}
                will be permanently removed. This cannot be undone.
              </p>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--ghost"
                  onClick={handleShipDeleteCancel}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--danger"
                  onClick={handleShipDeleteConfirm}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
