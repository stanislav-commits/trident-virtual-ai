import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createShip,
  deleteShip,
  updateShip,
  type ShipSummaryItem,
} from "../../api/shipsApi";
import {
  getUsers,
  updateUserShip,
  type UserListItem,
} from "../../api/usersApi";
import { useAdminShip } from "../../context/AdminShipContext";
import { useShipForm } from "../../hooks/admin/useShipForm";
import { PlusIcon, XIcon } from "./AdminPanelIcons";
import { ShipFormModal } from "./ships/ShipFormModal";
import { ShipsTable } from "./ships/ShipsTable";
import {
  normalizeOptionalText,
  normalizeOptionalYear,
} from "./ships/shipForm";

interface ShipsSectionProps {
  token: string | null;
  ships: ShipSummaryItem[];
  organizations: string[];
  organizationsLoading: boolean;
  loading: boolean;
  error: string;
  onLoadShips: () => Promise<void>;
  onError: (error: string) => void;
}

export function ShipsSection({
  token,
  ships,
  organizations,
  organizationsLoading,
  loading,
  error,
  onLoadShips,
  onError,
}: ShipsSectionProps) {
  const [submittingShip, setSubmittingShip] = useState(false);
  const [deletingShipId, setDeletingShipId] = useState<string | null>(null);
  const [shipPendingDelete, setShipPendingDelete] =
    useState<ShipSummaryItem | null>(null);
  const [crewUsers, setCrewUsers] = useState<UserListItem[]>([]);
  const [crewUsersLoading, setCrewUsersLoading] = useState(false);
  const [selectedCrewUserIds, setSelectedCrewUserIds] = useState<string[]>([]);
  const [movedCrewTargets, setMovedCrewTargets] = useState<Record<string, string>>(
    {},
  );
  const { refreshShips: refreshAdminShips } = useAdminShip();
  const {
    showFormModal,
    editingShipId,
    editingShip,
    shipForm,
    setShipForm,
    openCreateModal: openCreateState,
    openEditModal: openEditState,
    closeFormModal: closeFormState,
    resetShipForm,
  } = useShipForm(ships);

  const availableOrganizations = useMemo(
    () =>
      [
        ...new Set(
          [...organizations, shipForm.organizationName]
            .map((organization) => organization.trim())
            .filter(Boolean),
        ),
      ].sort((left, right) => left.localeCompare(right)),
    [organizations, shipForm.organizationName],
  );

  const loadCrewUsers = useCallback(async (): Promise<UserListItem[]> => {
    if (!token) {
      setCrewUsers([]);
      setCrewUsersLoading(false);
      return [];
    }

    setCrewUsersLoading(true);

    try {
      const users = await getUsers(token);
      const regularUsers = users.filter((user) => user.role === "user");
      setCrewUsers(regularUsers);
      return regularUsers;
    } catch (usersError) {
      onError(
        usersError instanceof Error
          ? usersError.message
          : "Failed to load crew users",
      );
      setCrewUsers([]);
      return [];
    } finally {
      setCrewUsersLoading(false);
    }
  }, [onError, token]);

  useEffect(() => {
    void loadCrewUsers();
  }, [loadCrewUsers]);

  const assignedUsersForEditingShip = useMemo(() => {
    if (!editingShipId) {
      return [];
    }

    return crewUsers.filter((user) => user.shipId === editingShipId);
  }, [crewUsers, editingShipId]);

  const removedAssignedUsers = useMemo(() => {
    const selectedSet = new Set(selectedCrewUserIds);

    return assignedUsersForEditingShip.filter((user) => !selectedSet.has(user.id));
  }, [assignedUsersForEditingShip, selectedCrewUserIds]);

  const hasUnresolvedCrewMoves = removedAssignedUsers.some(
    (user) => !movedCrewTargets[user.id],
  );

  const canSubmitShip =
    Boolean(token) &&
    !submittingShip &&
    !organizationsLoading &&
    availableOrganizations.length > 0 &&
    !hasUnresolvedCrewMoves;

  const syncAfterShipMutation = useCallback(async () => {
    await Promise.all([onLoadShips(), refreshAdminShips(), loadCrewUsers()]);
  }, [loadCrewUsers, onLoadShips, refreshAdminShips]);

  const openCreateModal = async () => {
    onError("");
    await loadCrewUsers();
    setSelectedCrewUserIds([]);
    setMovedCrewTargets({});
    openCreateState();
  };

  const openEditModal = async (ship: ShipSummaryItem) => {
    onError("");
    const nextCrewUsers = await loadCrewUsers();
    setSelectedCrewUserIds(
      nextCrewUsers
        .filter((user) => user.shipId === ship.id)
        .map((user) => user.id),
    );
    setMovedCrewTargets({});
    openEditState(ship);
  };

  const closeFormModal = () => {
    setSelectedCrewUserIds([]);
    setMovedCrewTargets({});
    closeFormState(submittingShip);
  };

  const closeDeleteModal = () => {
    if (deletingShipId) {
      return;
    }

    setShipPendingDelete(null);
  };

  const handleShipSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!token || !canSubmitShip) {
      return;
    }

    const name = shipForm.name.trim();
    const organizationName = shipForm.organizationName.trim();

    if (!name || !organizationName) {
      return;
    }

    setSubmittingShip(true);
    onError("");

    try {
      const payload = {
        name,
        organizationName,
        imoNumber: normalizeOptionalText(shipForm.imoNumber),
        buildYear: normalizeOptionalYear(shipForm.buildYear),
      };

      if (editingShipId) {
        await updateShip(editingShipId, payload, token);
      } else {
        const createdShip = await createShip(payload, token);
        const reassignmentTasks = selectedCrewUserIds.map((userId) =>
          updateUserShip(userId, createdShip.id, token),
        );

        if (reassignmentTasks.length > 0) {
          await Promise.all(reassignmentTasks);
        }

        resetShipForm();
        setSelectedCrewUserIds([]);
        setMovedCrewTargets({});
        await syncAfterShipMutation();
        return;
      }

      const reassignmentTasks: Promise<unknown>[] = [];

      for (const userId of selectedCrewUserIds) {
        const user = crewUsers.find((entry) => entry.id === userId);

        if (!user || user.shipId === editingShipId) {
          continue;
        }

        reassignmentTasks.push(updateUserShip(userId, editingShipId, token));
      }

      for (const user of removedAssignedUsers) {
        const targetShipId = movedCrewTargets[user.id];

        if (!targetShipId) {
          continue;
        }

        reassignmentTasks.push(updateUserShip(user.id, targetShipId, token));
      }

      if (reassignmentTasks.length > 0) {
        await Promise.all(reassignmentTasks);
      }

      resetShipForm();
      setSelectedCrewUserIds([]);
      setMovedCrewTargets({});
      await syncAfterShipMutation();
    } catch (shipError) {
      onError(
        shipError instanceof Error
          ? shipError.message
          : editingShipId
            ? "Failed to update ship"
            : "Failed to create ship",
      );
    } finally {
      setSubmittingShip(false);
    }
  };

  const handleDeleteRequest = (ship: ShipSummaryItem) => {
    if (submittingShip || deletingShipId) {
      return;
    }

    onError("");
    setShipPendingDelete(ship);
  };

  const handleDeleteConfirm = async () => {
    if (!token || !shipPendingDelete) {
      return;
    }

    setDeletingShipId(shipPendingDelete.id);
    onError("");

    try {
      await deleteShip(shipPendingDelete.id, token);
      setShipPendingDelete(null);
      await syncAfterShipMutation();
    } catch (deleteError) {
      onError(
        deleteError instanceof Error
          ? deleteError.message
          : "Failed to delete ship",
      );
    } finally {
      setDeletingShipId(null);
    }
  };

  const toggleCrewUser = (userId: string) => {
    setSelectedCrewUserIds((current) => {
      const exists = current.includes(userId);

      if (exists) {
        return current.filter((id) => id !== userId);
      }

      return [...current, userId];
    });

    setMovedCrewTargets((current) => {
      if (!(userId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[userId];
      return next;
    });
  };

  const setMovedCrewTarget = (userId: string, shipId: string) => {
    setMovedCrewTargets((current) => ({
      ...current,
      [userId]: shipId,
    }));
  };

  const pendingDeleteAssignedUsersCount = shipPendingDelete
    ? crewUsers.filter((user) => user.shipId === shipPendingDelete.id).length
    : 0;

  return (
    <>
      <section className="admin-panel__section">
        <div className="admin-panel__section-head">
          <div>
            <h2 className="admin-panel__section-title">Ships</h2>
            <p className="admin-panel__section-subtitle">
              Create the ship registry with the minimum data we need up front.
              Organization options are loaded from telemetry.
            </p>
          </div>
          <button
            type="button"
            className="admin-panel__btn admin-panel__btn--primary"
            onClick={() => void openCreateModal()}
          >
            <PlusIcon /> Add ship
          </button>
        </div>

        {error && (
          <div className="admin-panel__error" role="alert">
            {error}
          </div>
        )}

        <ShipsTable
          ships={ships}
          loading={loading}
          onEdit={(ship) => void openEditModal(ship)}
          onDelete={handleDeleteRequest}
          deletingShipId={deletingShipId}
        />
      </section>

      <ShipFormModal
        canSubmit={canSubmitShip}
        editingShip={editingShip}
        form={shipForm}
        isOpen={showFormModal}
        organizations={availableOrganizations}
        organizationsLoading={organizationsLoading}
        crewUsers={crewUsers}
        crewUsersLoading={crewUsersLoading}
        selectedCrewUserIds={selectedCrewUserIds}
        movedCrewTargets={movedCrewTargets}
        currentAssignedUsers={assignedUsersForEditingShip}
        shipOptions={ships.map((ship) => ({ id: ship.id, name: ship.name }))}
        submitting={submittingShip}
        onClose={closeFormModal}
        onFormChange={setShipForm}
        onToggleCrewUser={toggleCrewUser}
        onMovedCrewTargetChange={setMovedCrewTarget}
        onSubmit={handleShipSubmit}
      />

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
