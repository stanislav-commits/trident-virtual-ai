import { useState } from "react";
import {
  createShip,
  updateShip,
  deleteShip,
  type ShipListItem,
  type MetricDefinitionItem,
  type UserListItem,
} from "../../api/client";
import { ShipIcon, XIcon, PlusIcon } from "./AdminPanelIcons";

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
  onShipCreated,
  onOpenManuals,
}: ShipsSectionProps) {
  const [shipForm, setShipForm] = useState<ShipForm>({
    name: "",
    serialNumber: "",
    metricKeys: [],
    userIds: [],
  });
  const [creatingShip, setCreatingShip] = useState(false);
  const [editingShipId, setEditingShipId] = useState<string | null>(null);
  const [deletingShipId, setDeletingShipId] = useState<string | null>(null);
  const [shipDeleteConfirm, setShipDeleteConfirm] =
    useState<DeleteConfirm | null>(null);
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

  const handleShipEdit = (ship: ShipListItem) => {
    setEditingShipId(ship.id);
    setShipForm({
      name: ship.name,
      serialNumber: ship.serialNumber ?? "",
      metricKeys: ship.metricsConfig.map((c) => c.metricKey),
      userIds: (ship.assignedUsers ?? []).map((u) => u.id),
    });
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
      setShipForm({ name: "", serialNumber: "", metricKeys: [], userIds: [] });
      onShipCreated?.(created.id, shipForm.name.trim());
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
          {editingShipId ? (
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              onClick={() => {
                setEditingShipId(null);
                setShipForm({
                  name: "",
                  serialNumber: "",
                  metricKeys: [],
                  userIds: [],
                });
              }}
            >
              Cancel edit
            </button>
          ) : null}
        </div>

        {editingShipId ? (
          <>
            <div className="admin-panel__form-card">
              <h3 className="admin-panel__form-card-title">Edit ship</h3>
              <form
                onSubmit={handleShipEditSubmit}
                className="admin-panel__ship-form"
              >
                <div className="admin-panel__form-row">
                  <div className="admin-panel__field">
                    <label className="admin-panel__field-label">Name</label>
                    <input
                      type="text"
                      value={shipForm.name}
                      onChange={(e) =>
                        setShipForm((p) => ({
                          ...p,
                          name: e.target.value,
                        }))
                      }
                      className="admin-panel__input"
                      required
                      disabled={creatingShip}
                    />
                  </div>
                  <div className="admin-panel__field">
                    <label className="admin-panel__field-label">
                      Serial number
                    </label>
                    <input
                      type="text"
                      value={shipForm.serialNumber}
                      onChange={(e) =>
                        setShipForm((p) => ({
                          ...p,
                          serialNumber: e.target.value,
                        }))
                      }
                      className="admin-panel__input"
                      placeholder="Optional"
                      disabled={creatingShip}
                    />
                  </div>
                </div>
                <div className="admin-panel__field">
                  <span className="admin-panel__field-label">Metrics</span>
                  <div className="admin-panel__metrics-grid">
                    {metricDefinitions.map((m) => (
                      <label key={m.key} className="admin-panel__metric-chip">
                        <input
                          type="checkbox"
                          checked={shipForm.metricKeys.includes(m.key)}
                          onChange={() => toggleMetricKey(m.key)}
                          disabled={creatingShip}
                          className="admin-panel__metric-check"
                        />
                        <span className="admin-panel__metric-name">
                          {m.label}
                        </span>
                        {m.unit && (
                          <span className="admin-panel__metric-unit">
                            {m.unit}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
                {users.filter(
                  (u) =>
                    u.role === "user" &&
                    (u.shipId == null || u.shipId === editingShipId),
                ).length > 0 && (
                  <div className="admin-panel__field">
                    <span className="admin-panel__field-label">
                      Assigned users
                    </span>
                    <div className="admin-panel__metrics-grid">
                      {users
                        .filter(
                          (u) =>
                            u.role === "user" &&
                            (u.shipId == null || u.shipId === editingShipId),
                        )
                        .map((u) => (
                          <label
                            key={u.id}
                            className="admin-panel__metric-chip"
                          >
                            <input
                              type="checkbox"
                              checked={shipForm.userIds.includes(u.id)}
                              onChange={() => toggleShipUserId(u.id)}
                              disabled={creatingShip}
                              className="admin-panel__metric-check"
                            />
                            <span className="admin-panel__metric-name">
                              {u.userId}
                            </span>
                          </label>
                        ))}
                    </div>
                  </div>
                )}
                <div className="admin-panel__form-actions">
                  <button
                    type="submit"
                    className="admin-panel__btn admin-panel__btn--primary"
                    disabled={creatingShip}
                  >
                    {creatingShip ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </form>
            </div>
          </>
        ) : (
          <div className="admin-panel__form-card">
            <h3 className="admin-panel__form-card-title">New ship</h3>
            <form
              onSubmit={handleShipCreate}
              className="admin-panel__ship-form"
            >
              <div className="admin-panel__form-row">
                <div className="admin-panel__field">
                  <label className="admin-panel__field-label">Name</label>
                  <input
                    type="text"
                    value={shipForm.name}
                    onChange={(e) =>
                      setShipForm((p) => ({
                        ...p,
                        name: e.target.value,
                      }))
                    }
                    className="admin-panel__input"
                    placeholder="Ship name"
                    required
                    disabled={creatingShip}
                  />
                </div>
                <div className="admin-panel__field">
                  <label className="admin-panel__field-label">
                    Serial number
                  </label>
                  <input
                    type="text"
                    value={shipForm.serialNumber}
                    onChange={(e) =>
                      setShipForm((p) => ({
                        ...p,
                        serialNumber: e.target.value,
                      }))
                    }
                    className="admin-panel__input"
                    placeholder="Optional"
                    disabled={creatingShip}
                  />
                </div>
              </div>
              {metricDefinitions.length > 0 && (
                <div className="admin-panel__field">
                  <span className="admin-panel__field-label">Metrics</span>
                  <div className="admin-panel__metrics-grid">
                    {metricDefinitions.map((m) => (
                      <label key={m.key} className="admin-panel__metric-chip">
                        <input
                          type="checkbox"
                          checked={shipForm.metricKeys.includes(m.key)}
                          onChange={() => toggleMetricKey(m.key)}
                          disabled={creatingShip}
                          className="admin-panel__metric-check"
                        />
                        <span className="admin-panel__metric-name">
                          {m.label}
                        </span>
                        {m.unit && (
                          <span className="admin-panel__metric-unit">
                            {m.unit}
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {users.filter((u) => u.role === "user" && u.shipId == null)
                .length > 0 && (
                <div className="admin-panel__field">
                  <span className="admin-panel__field-label">
                    Assigned users
                  </span>
                  <div className="admin-panel__metrics-grid">
                    {users
                      .filter((u) => u.role === "user" && u.shipId == null)
                      .map((u) => (
                        <label key={u.id} className="admin-panel__metric-chip">
                          <input
                            type="checkbox"
                            checked={shipForm.userIds.includes(u.id)}
                            onChange={() => toggleShipUserId(u.id)}
                            disabled={creatingShip}
                            className="admin-panel__metric-check"
                          />
                          <span className="admin-panel__metric-name">
                            {u.userId}
                          </span>
                        </label>
                      ))}
                  </div>
                </div>
              )}
              <div className="admin-panel__form-actions">
                <button
                  type="submit"
                  className="admin-panel__btn admin-panel__btn--primary"
                  disabled={creatingShip}
                >
                  <PlusIcon />
                  {creatingShip ? "Creating…" : "Create ship"}
                </button>
              </div>
            </form>
          </div>
        )}

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
                        <div className="admin-panel__metric-tags">
                          {ship.metricsConfig.map((c) => (
                            <span
                              key={c.metricKey}
                              className="admin-panel__metric-tag"
                            >
                              {c.metricKey}
                            </span>
                          ))}
                        </div>
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
                              {u.userId}
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
                          disabled={
                            !!editingShipId || deletingShipId === ship.id
                          }
                        >
                          Manuals
                        </button>
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--ghost"
                          onClick={() => handleShipEdit(ship)}
                          disabled={
                            !!editingShipId || deletingShipId === ship.id
                          }
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="admin-panel__btn admin-panel__btn--danger"
                          onClick={() =>
                            handleShipDeleteClick(ship.id, ship.name)
                          }
                          disabled={
                            !!editingShipId || deletingShipId === ship.id
                          }
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

      {shipDeleteConfirm && (
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
            <h2 id="ap-ship-delete-title" className="admin-panel__modal-title">
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
        </div>
      )}
    </>
  );
}
