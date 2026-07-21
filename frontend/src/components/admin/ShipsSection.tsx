import { createPortal } from "react-dom";
import { useCallback, useEffect, useState } from "react";
import { deleteShip, type ShipSummaryItem } from "../../api/shipsApi";
import { getUsers, type UserListItem } from "../../api/usersApi";
import { useAdminShip } from "../../context/AdminShipContext";
import { useAdminEvents } from "../../hooks/admin/adminEvents";
import { XIcon } from "./AdminPanelIcons";
import { ShipsTable } from "./ships/ShipsTable";
import { AddVesselModal } from "./AddVesselModal";

interface ShipsSectionProps {
  token: string | null;
  ships: ShipSummaryItem[];
  organizations: string[];
  organizationsLoading: boolean;
  loading: boolean;
  error: string;
  onLoadShips: () => Promise<void>;
  onError: (error: string) => void;
  onRemoveShipLocal: (shipId: string) => ShipSummaryItem[];
  onRestoreShips: (prev: ShipSummaryItem[]) => void;
}

/**
 * Ships registry: list all vessels, edit (full profile + crew via the shared
 * AddVesselModal), and delete. Vessel CREATION lives in the vessel switcher
 * (the rich "Add vessel" workspace) — not here.
 */
export function ShipsSection({
  token,
  ships,
  loading,
  error,
  onLoadShips,
  onError,
  onRemoveShipLocal,
  onRestoreShips,
}: ShipsSectionProps) {
  const { refreshShips: refreshAdminShips } = useAdminShip();
  const [editingShip, setEditingShip] = useState<ShipSummaryItem | null>(null);
  const [deletingShipId, setDeletingShipId] = useState<string | null>(null);
  const [shipPendingDelete, setShipPendingDelete] =
    useState<ShipSummaryItem | null>(null);
  const [crewUsers, setCrewUsers] = useState<UserListItem[]>([]);

  const loadCrewUsers = useCallback(async () => {
    if (!token) {
      setCrewUsers([]);
      return;
    }
    try {
      const users = await getUsers(token);
      setCrewUsers(users.filter((u) => u.role === "user"));
    } catch {
      setCrewUsers([]);
    }
  }, [token]);

  useEffect(() => {
    void loadCrewUsers();
  }, [loadCrewUsers]);

  const refreshAfterMutation = useCallback(async () => {
    await Promise.all([onLoadShips(), refreshAdminShips(), loadCrewUsers()]);
  }, [loadCrewUsers, onLoadShips, refreshAdminShips]);

  // Live-sync: ships are platform-scoped — any admin's change re-loads.
  useAdminEvents("ships", () => {
    void refreshAfterMutation();
  });

  const handleDeleteRequest = (ship: ShipSummaryItem) => {
    if (deletingShipId) return;
    onError("");
    setShipPendingDelete(ship);
  };

  const closeDeleteModal = () => {
    if (deletingShipId) return;
    setShipPendingDelete(null);
  };

  const handleDeleteConfirm = async () => {
    if (!token || !shipPendingDelete) return;
    const deletingId = shipPendingDelete.id;
    setDeletingShipId(deletingId);
    onError("");
    // Optimistic: drop the vessel row instantly and close the dialog;
    // reconcile (ships list + admin vessel switcher + crew counts) in the
    // background, restore on failure.
    const prev = onRemoveShipLocal(deletingId);
    setShipPendingDelete(null);
    try {
      await deleteShip(deletingId, token);
      void refreshAfterMutation();
    } catch (deleteError) {
      onRestoreShips(prev);
      onError(
        deleteError instanceof Error ? deleteError.message : "Failed to delete ship",
      );
    } finally {
      setDeletingShipId(null);
    }
  };

  const pendingDeleteAssignedUsersCount = shipPendingDelete
    ? crewUsers.filter((u) => u.shipId === shipPendingDelete.id).length
    : 0;

  return (
    <>
      <section className="admin-panel__section ships-section">
        <div className="admin-panel__section-head">
          <div>
            <h2 className="admin-panel__section-title">Ships</h2>
            <p className="admin-panel__section-subtitle">
              All vessels in the registry — general information and editing. To
              add a new vessel, use “Add vessel” in the vessel switcher.
            </p>
          </div>
        </div>

        {error && (
          <div className="admin-panel__error" role="alert">
            {error}
          </div>
        )}

        <ShipsTable
          ships={ships}
          loading={loading}
          onEdit={(ship) => setEditingShip(ship)}
          onDelete={handleDeleteRequest}
          deletingShipId={deletingShipId}
        />
      </section>

      {editingShip && (
        <AddVesselModal
          editShip={editingShip}
          onClose={() => {
            setEditingShip(null);
            void refreshAfterMutation();
          }}
        />
      )}

      {shipPendingDelete &&
        createPortal(
          <div
            className="admin-panel__modal-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ap-delete-ship-title"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                closeDeleteModal();
              }
            }}
          >
            <div className="admin-panel__modal">
              <div className="admin-panel__modal-icon admin-panel__modal-icon--danger">
                <XIcon />
              </div>
              <h2 id="ap-delete-ship-title" className="admin-panel__modal-title">
                Delete this ship?
              </h2>
              <p className="admin-panel__modal-desc">
                Ship{" "}
                <code className="admin-panel__code">{shipPendingDelete.name}</code>{" "}
                will be permanently removed from the registry. Metric catalog
                entries for this ship will be deleted as well. This cannot be undone.
              </p>
              <div className="admin-panel__state-box admin-panel__state-box--compact">
                <span className="admin-panel__muted">
                  Assigned users must be reassigned or removed first.
                  {pendingDeleteAssignedUsersCount > 0
                    ? ` This ship currently has ${pendingDeleteAssignedUsersCount} assigned user${pendingDeleteAssignedUsersCount === 1 ? "" : "s"}.`
                    : " No assigned users are currently attached to this ship."}
                </span>
              </div>
              <div className="admin-panel__modal-actions">
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--ghost"
                  onClick={closeDeleteModal}
                  disabled={Boolean(deletingShipId)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="admin-panel__btn admin-panel__btn--danger"
                  onClick={() => void handleDeleteConfirm()}
                  disabled={Boolean(deletingShipId)}
                >
                  {deletingShipId === shipPendingDelete.id
                    ? "Deleting..."
                    : "Delete ship"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
