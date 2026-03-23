import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  createShip,
  deleteShip,
  updateShip,
  uploadManual,
  type MetricDefinitionItem,
  type ShipListItem,
  type UserListItem,
} from "../../api/client";
import {
  ChevronDownIcon,
  PlusIcon,
  SearchIcon,
  ShipIcon,
  UploadIcon,
  XIcon,
} from "./AdminPanelIcons";

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
  placeholder = "Select...",
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
  const [visibleCount, setVisibleCount] = useState(80);
  const wrapRef = useRef<HTMLDivElement>(null);
  const deferredSearch = useDeferredValue(search);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    setVisibleCount(80);
  }, [deferredSearch, open, options.length]);

  const filtered = options.filter((option) =>
    option.label.toLowerCase().includes(deferredSearch.toLowerCase()),
  );
  const visibleOptions = filtered.slice(0, visibleCount);

  const selectedItems = options.filter((option) =>
    selected.includes(option.key),
  );

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
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search..."
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
              visibleOptions.map((option) => (
                <label key={option.key} className="admin-panel__picker-option">
                  <input
                    type="checkbox"
                    className="admin-panel__picker-check"
                    checked={selected.includes(option.key)}
                    onChange={() => onToggle(option.key)}
                  />
                  <span className="admin-panel__picker-option-label">
                    {option.label}
                  </span>
                  {option.extra && (
                    <span className="admin-panel__picker-option-extra">
                      {option.extra}
                    </span>
                  )}
                </label>
              ))
            )}
          </div>
          {filtered.length > visibleOptions.length && (
            <div className="admin-panel__picker-footer">
              <button
                type="button"
                className="admin-panel__picker-action-btn"
                onClick={() => setVisibleCount((current) => current + 80)}
                disabled={disabled}
              >
                Load 80 more
              </button>
              <span className="admin-panel__picker-footer-meta">
                Showing {visibleOptions.length} of {filtered.length}
              </span>
            </div>
          )}
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
                x
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
  organizations: string[];
  organizationsLoading: boolean;
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
  organizationName: string;
  imoNumber: string;
  flag: string;
  deadweight: string;
  grossTonnage: string;
  buildYard: string;
  shipClass: string;
  userIds: string[];
}

interface DeleteConfirm {
  id: string;
  name: string;
}

function createEmptyShipForm(): ShipForm {
  return {
    name: "",
    organizationName: "",
    imoNumber: "",
    flag: "",
    deadweight: "",
    grossTonnage: "",
    buildYard: "",
    shipClass: "",
    userIds: [],
  };
}

function normalizeOptionalTextField(value: string) {
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeOptionalNumberField(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasMetricDescription(description: string | null | undefined) {
  return Boolean(description?.trim());
}

function getMetricDescriptionStats(
  metricKeys: string[],
  definitionMap: Map<string, MetricDefinitionItem>,
) {
  const total = metricKeys.length;
  let described = 0;

  for (const metricKey of metricKeys) {
    if (hasMetricDescription(definitionMap.get(metricKey)?.description)) {
      described += 1;
    }
  }

  return {
    total,
    described,
    pending: Math.max(total - described, 0),
  };
}

function getShipSyncNote(
  ship: Pick<ShipListItem, "metricsSyncStatus" | "metricsSyncError">,
) {
  switch (ship.metricsSyncStatus) {
    case "pending":
      return "Metric sync queued";
    case "running":
      return "Syncing metrics...";
    case "failed":
      return ship.metricsSyncError?.trim() || "Metric sync failed";
    default:
      return null;
  }
}

export function ShipsSection({
  token,
  ships,
  users,
  organizations,
  organizationsLoading,
  metricDefinitions,
  loading,
  onLoadShips,
  onError,
  onOpenManuals,
  onOpenMetrics,
}: ShipsSectionProps) {
  const [shipForm, setShipForm] = useState<ShipForm>(createEmptyShipForm);
  const [showFormModal, setShowFormModal] = useState(false);
  const [creatingShip, setCreatingShip] = useState(false);
  const [submitMessage, setSubmitMessage] = useState("");
  const [editingShipId, setEditingShipId] = useState<string | null>(null);
  const [originalOrganizationName, setOriginalOrganizationName] = useState<
    string | null
  >(null);
  const [deletingShipId, setDeletingShipId] = useState<string | null>(null);
  const [shipDeleteConfirm, setShipDeleteConfirm] =
    useState<DeleteConfirm | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const editingShip = editingShipId
    ? (ships.find((ship) => ship.id === editingShipId) ?? null)
    : null;

  const organizationChanged =
    editingShipId != null &&
    shipForm.organizationName.trim() !== (originalOrganizationName ?? "");

  const metricDefinitionMap = useMemo(
    () =>
      new Map(
        metricDefinitions.map((definition) => [definition.key, definition]),
      ),
    [metricDefinitions],
  );

  const editingDescriptionStats = useMemo(() => {
    if (!editingShip) {
      return { total: 0, described: 0, pending: 0 };
    }

    return getMetricDescriptionStats(
      editingShip.metricsConfig.map((config) => config.metricKey),
      metricDefinitionMap,
    );
  }, [editingShip, metricDefinitionMap]);

  const availableOrganizations = useMemo(() => {
    const values = new Set(organizations);
    if (shipForm.organizationName.trim()) {
      values.add(shipForm.organizationName.trim());
    }
    return [...values].sort((left, right) => left.localeCompare(right));
  }, [organizations, shipForm.organizationName]);

  const assignableUsers = useMemo(
    () =>
      users.filter(
        (user) =>
          user.role === "user" &&
          (user.shipId == null || user.shipId === editingShipId),
      ),
    [editingShipId, users],
  );

  const footerHint = editingShipId
    ? organizationChanged
      ? "Changing the organization saves immediately and refreshes ship metrics in background."
      : editingShip?.metricsSyncStatus === "failed"
        ? editingShip.metricsSyncError?.trim() ||
          "The last metric sync failed."
        : editingShip?.metricsSyncStatus === "pending" ||
            editingShip?.metricsSyncStatus === "running"
          ? "This ship is already syncing metrics in background."
          : editingDescriptionStats.pending > 0
            ? `${editingDescriptionStats.pending.toLocaleString()} metric descriptions are still generating in background.`
            : "Descriptions continue in background. Metric activation is managed from the Metrics window."
    : "Metrics sync starts after save and continues in background. Activation can be adjusted later from the Metrics window.";

  const toggleShipUserId = (id: string) => {
    setShipForm((previous) => ({
      ...previous,
      userIds: previous.userIds.includes(id)
        ? previous.userIds.filter((userId) => userId !== id)
        : [...previous.userIds, id],
    }));
  };

  const openCreateModal = () => {
    setEditingShipId(null);
    setOriginalOrganizationName(null);
    setSubmitMessage("");
    setShipForm(createEmptyShipForm());
    setPendingFiles([]);
    setShowFormModal(true);
  };

  const closeFormModal = () => {
    if (creatingShip) return;
    setShowFormModal(false);
    setEditingShipId(null);
    setOriginalOrganizationName(null);
    setSubmitMessage("");
    setShipForm(createEmptyShipForm());
    setPendingFiles([]);
  };

  const handleShipEdit = (ship: ShipListItem) => {
    setEditingShipId(ship.id);
    setOriginalOrganizationName(ship.organizationName ?? "");
    setSubmitMessage("");
    setShipForm({
      name: ship.name,
      organizationName: ship.organizationName ?? "",
      imoNumber: ship.imoNumber ?? "",
      flag: ship.flag ?? "",
      deadweight:
        ship.deadweight != null ? String(ship.deadweight) : "",
      grossTonnage:
        ship.grossTonnage != null ? String(ship.grossTonnage) : "",
      buildYard: ship.buildYard ?? "",
      shipClass: ship.shipClass ?? "",
      userIds: (ship.assignedUsers ?? []).map((user) => user.id),
    });
    setPendingFiles([]);
    setShowFormModal(true);
  };

  const handleShipEditSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = shipForm.name.trim();
    const organizationName = shipForm.organizationName.trim();
    if (!token || !editingShipId || !name || !organizationName) return;

    setCreatingShip(true);
    setSubmitMessage(
      organizationChanged
        ? "Saving ship and queuing a background metric sync..."
        : "Saving ship changes...",
    );
    onError("");

    try {
      await updateShip(
        editingShipId,
        {
          name,
          organizationName,
          imoNumber: normalizeOptionalTextField(shipForm.imoNumber),
          flag: normalizeOptionalTextField(shipForm.flag),
          deadweight: normalizeOptionalNumberField(shipForm.deadweight),
          grossTonnage: normalizeOptionalNumberField(shipForm.grossTonnage),
          buildYard: normalizeOptionalTextField(shipForm.buildYard),
          shipClass: normalizeOptionalTextField(shipForm.shipClass),
          userIds: shipForm.userIds,
        },
        token,
      );
      setEditingShipId(null);
      setOriginalOrganizationName(null);
      setShowFormModal(false);
      setSubmitMessage("");
      setShipForm(createEmptyShipForm());
      await onLoadShips();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to update ship");
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
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to delete ship");
    } finally {
      setDeletingShipId(null);
    }
  };

  const handleShipCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = shipForm.name.trim();
    const organizationName = shipForm.organizationName.trim();
    if (!token || !name || !organizationName) return;

    setCreatingShip(true);
    setSubmitMessage("Creating ship and queuing metric sync...");
    onError("");

    try {
      const created = await createShip(
        {
          name,
          organizationName,
          imoNumber: normalizeOptionalTextField(shipForm.imoNumber),
          flag: normalizeOptionalTextField(shipForm.flag),
          deadweight: normalizeOptionalNumberField(shipForm.deadweight),
          grossTonnage: normalizeOptionalNumberField(shipForm.grossTonnage),
          buildYard: normalizeOptionalTextField(shipForm.buildYard),
          shipClass: normalizeOptionalTextField(shipForm.shipClass),
          userIds: shipForm.userIds.length ? shipForm.userIds : undefined,
        },
        token,
      );

      if (pendingFiles.length > 0) {
        const uploadErrors: string[] = [];
        for (const file of pendingFiles) {
          try {
            await uploadManual(created.id, file, token);
          } catch (error) {
            uploadErrors.push(
              `${file.name}: ${error instanceof Error ? error.message : "upload failed"}`,
            );
          }
        }
        if (uploadErrors.length) {
          onError(
            `Ship created but manual upload failed: ${uploadErrors.join("; ")}`,
          );
        }
      }

      setShipForm(createEmptyShipForm());
      setPendingFiles([]);
      setShowFormModal(false);
      setSubmitMessage("");
      await onLoadShips();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to create ship");
    } finally {
      setCreatingShip(false);
    }
  };

  return (
    <>
      <section className="admin-panel__section">
        <div className="admin-panel__section-head">
          <div className="admin-panel__section-intro">
            <h2 className="admin-panel__section-title">Ships</h2>
            <p className="admin-panel__section-subtitle">
              Bind ships to an organization and sync metrics automatically.
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
            <span className="admin-panel__muted">Loading ships...</span>
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
                  <th className="admin-panel__th">Organization</th>
                  <th className="admin-panel__th">Metrics</th>
                  <th className="admin-panel__th">Users</th>
                  <th className="admin-panel__th">Actions</th>
                </tr>
              </thead>
              <tbody>
                {ships.map((ship) => {
                  const activeMetricCount = ship.metricsConfig.filter(
                    (config) => config.isActive,
                  ).length;
                  const descriptionStats = getMetricDescriptionStats(
                    ship.metricsConfig.map((config) => config.metricKey),
                    metricDefinitionMap,
                  );
                  const syncNote = getShipSyncNote(ship);

                  return (
                    <tr key={ship.id} className="admin-panel__row">
                      <td className="admin-panel__td admin-panel__td--name">
                        {ship.name}
                      </td>
                      <td className="admin-panel__td admin-panel__td--serial">
                        {ship.organizationName ?? "-"}
                      </td>
                      <td className="admin-panel__td admin-panel__td--metrics">
                        {ship.metricsConfig.length ? (
                          <div className="admin-panel__ship-metric-cell">
                            <button
                              type="button"
                              className="admin-panel__btn admin-panel__btn--ghost"
                              onClick={() => onOpenMetrics?.(ship)}
                            >
                              Metrics
                              <span className="admin-panel__count-badge">
                                {activeMetricCount === ship.metricsConfig.length
                                  ? ship.metricsConfig.length.toLocaleString()
                                  : `${activeMetricCount}/${ship.metricsConfig.length}`}
                              </span>
                            </button>
                            {syncNote ? (
                              <span
                                className={`admin-panel__ship-metric-note ${
                                  ship.metricsSyncStatus === "failed"
                                    ? "admin-panel__ship-metric-note--error"
                                    : "admin-panel__ship-metric-note--info"
                                }`}
                              >
                                {syncNote}
                              </span>
                            ) : descriptionStats.pending > 0 ? (
                              <span className="admin-panel__ship-metric-note">
                                {descriptionStats.pending.toLocaleString()} descriptions pending
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <div className="admin-panel__ship-metric-cell">
                            <span className="admin-panel__muted">-</span>
                            {syncNote && (
                              <span
                                className={`admin-panel__ship-metric-note ${
                                  ship.metricsSyncStatus === "failed"
                                    ? "admin-panel__ship-metric-note--error"
                                    : "admin-panel__ship-metric-note--info"
                                }`}
                              >
                                {syncNote}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="admin-panel__td admin-panel__td--metrics">
                        {(ship.assignedUsers?.length ?? 0) > 0 ? (
                          <div className="admin-panel__metric-tags">
                            {(ship.assignedUsers ?? []).map((user) => (
                              <span
                                key={user.id}
                                className="admin-panel__metric-tag"
                              >
                                {user.name?.trim() || user.userId}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="admin-panel__muted">-</span>
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
                            Knowledge Base
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
                            {deletingShipId === ship.id ? "..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showFormModal &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-ship-form-title"
            onClick={(event) => {
              if (event.target === event.currentTarget) closeFormModal();
            }}
          >
            <div className="admin-panel__modal admin-panel__modal--large admin-panel__modal--scrollable">
              <button
                type="button"
                className="admin-panel__modal-close"
                onClick={closeFormModal}
                aria-label="Close"
              >
                <XIcon />
              </button>
              <div className="admin-panel__modal-head">
                <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
                  <ShipIcon />
                </div>
                <h2
                  id="ap-ship-form-title"
                  className="admin-panel__modal-title"
                >
                  {editingShipId ? "Edit ship" : "Create new ship"}
                </h2>
                <p className="admin-panel__modal-desc">
                  {editingShipId
                    ? "Update ship details and organization. Manage metric activation from the Metrics window."
                    : "Bind a ship to an organization and sync metrics automatically in background after save."}
                </p>
              </div>
              <form
                onSubmit={
                  editingShipId ? handleShipEditSubmit : handleShipCreate
                }
                className="admin-panel__modal-form admin-panel__modal-form--fill"
              >
                <div className="admin-panel__modal-body">
                  <div className="admin-panel__modal-field-row">
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">
                        Ship name
                      </label>
                      <input
                        type="text"
                        className="admin-panel__input admin-panel__input--full"
                        value={shipForm.name}
                        onChange={(event) =>
                          setShipForm((previous) => ({
                            ...previous,
                            name: event.target.value,
                          }))
                        }
                        placeholder="e.g. Ocean Explorer"
                        required
                        disabled={creatingShip}
                        autoFocus
                      />
                    </div>
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">
                        Organization
                      </label>
                      <select
                        className="admin-panel__input admin-panel__input--full"
                        value={shipForm.organizationName}
                        onChange={(event) =>
                          setShipForm((previous) => ({
                            ...previous,
                            organizationName: event.target.value,
                          }))
                        }
                        disabled={creatingShip || organizationsLoading}
                        required
                      >
                        <option value="">
                          {organizationsLoading
                            ? "Loading organizations..."
                            : "Select an organization"}
                        </option>
                        {availableOrganizations.map((organization) => (
                          <option key={organization} value={organization}>
                            {organization}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="admin-panel__modal-field-row">
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">
                        IMO number
                      </label>
                      <input
                        type="text"
                        className="admin-panel__input admin-panel__input--full"
                        value={shipForm.imoNumber}
                        onChange={(event) =>
                          setShipForm((previous) => ({
                            ...previous,
                            imoNumber: event.target.value,
                          }))
                        }
                        placeholder="e.g. 9781234"
                        disabled={creatingShip}
                      />
                    </div>
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">Flag</label>
                      <input
                        type="text"
                        className="admin-panel__input admin-panel__input--full"
                        value={shipForm.flag}
                        onChange={(event) =>
                          setShipForm((previous) => ({
                            ...previous,
                            flag: event.target.value,
                          }))
                        }
                        placeholder="e.g. Malta"
                        disabled={creatingShip}
                      />
                    </div>
                  </div>

                  <div className="admin-panel__modal-field-row">
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">
                        Deadweight
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        className="admin-panel__input admin-panel__input--full"
                        value={shipForm.deadweight}
                        onChange={(event) =>
                          setShipForm((previous) => ({
                            ...previous,
                            deadweight: event.target.value,
                          }))
                        }
                        placeholder="e.g. 12500"
                        disabled={creatingShip}
                      />
                    </div>
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">
                        Gross tonnage
                      </label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        inputMode="numeric"
                        className="admin-panel__input admin-panel__input--full"
                        value={shipForm.grossTonnage}
                        onChange={(event) =>
                          setShipForm((previous) => ({
                            ...previous,
                            grossTonnage: event.target.value,
                          }))
                        }
                        placeholder="e.g. 9800"
                        disabled={creatingShip}
                      />
                    </div>
                  </div>

                  <div className="admin-panel__modal-field-row">
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">
                        Build yard
                      </label>
                      <input
                        type="text"
                        className="admin-panel__input admin-panel__input--full"
                        value={shipForm.buildYard}
                        onChange={(event) =>
                          setShipForm((previous) => ({
                            ...previous,
                            buildYard: event.target.value,
                          }))
                        }
                        placeholder="e.g. Damen Shipyards"
                        disabled={creatingShip}
                      />
                    </div>
                    <div className="admin-panel__modal-field">
                      <label className="admin-panel__field-label">Class</label>
                      <input
                        type="text"
                        className="admin-panel__input admin-panel__input--full"
                        value={shipForm.shipClass}
                        onChange={(event) =>
                          setShipForm((previous) => ({
                            ...previous,
                            shipClass: event.target.value,
                          }))
                        }
                        placeholder="e.g. Lloyd's Register"
                        disabled={creatingShip}
                      />
                    </div>
                  </div>

                {assignableUsers.length > 0 && (
                  <div className="admin-panel__modal-field">
                    <span className="admin-panel__field-label">
                      Assigned users
                    </span>
                    <MultiSelectPicker
                      options={assignableUsers.map((user) => ({
                        key: user.id,
                        label: user.name?.trim() || user.userId,
                      }))}
                      selected={shipForm.userIds}
                      onToggle={toggleShipUserId}
                      disabled={creatingShip}
                      placeholder="Assign users..."
                    />
                  </div>
                )}

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
                      onDragOver={(event) => {
                        event.preventDefault();
                        event.currentTarget.classList.add(
                          "admin-panel__dropzone--active",
                        );
                      }}
                      onDragLeave={(event) =>
                        event.currentTarget.classList.remove(
                          "admin-panel__dropzone--active",
                        )
                      }
                      onDrop={(event) => {
                        event.preventDefault();
                        event.currentTarget.classList.remove(
                          "admin-panel__dropzone--active",
                        );
                        if (creatingShip) return;
                        const dropped = Array.from(
                          event.dataTransfer.files,
                        ).filter((file) =>
                          /\.(pdf|doc|docx|txt)$/i.test(file.name),
                        );
                        if (dropped.length) {
                          setPendingFiles((previous) => [
                            ...previous,
                            ...dropped,
                          ]);
                        }
                      }}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept=".pdf,.doc,.docx,.txt,.md,.csv,.jpg,.jpeg,.png,.bmp,.svg"
                        className="admin-panel__dropzone-input"
                        onChange={(event) => {
                          const files = Array.from(event.target.files ?? []);
                          if (files.length) {
                            setPendingFiles((previous) => [
                              ...previous,
                              ...files,
                            ]);
                          }
                          event.target.value = "";
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
                        {pendingFiles.map((file, index) => (
                          <span
                            key={`${file.name}-${index}`}
                            className="admin-panel__picker-chip"
                          >
                            <span className="admin-panel__picker-chip-text">
                              {file.name}
                            </span>
                            <button
                              type="button"
                              className="admin-panel__picker-chip-x"
                              onClick={() =>
                                setPendingFiles((previous) =>
                                  previous.filter(
                                    (_, currentIndex) => currentIndex !== index,
                                  ),
                                )
                              }
                              disabled={creatingShip}
                            >
                              x
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                </div>

                <div className="admin-panel__modal-footer">
                  <div className="admin-panel__inline-meta">{footerHint}</div>
                  {creatingShip && submitMessage && (
                  <div className="admin-panel__inline-progress">
                    <div className="admin-panel__spinner" />
                    <span className="admin-panel__muted">{submitMessage}</span>
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
                    disabled={
                      creatingShip ||
                      !shipForm.name.trim() ||
                      !shipForm.organizationName.trim()
                    }
                  >
                    {creatingShip
                      ? "Syncing..."
                      : editingShipId
                        ? "Save changes"
                        : "Create ship"}
                  </button>
                </div>
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
