import type { UserListItem } from "../../../api/usersApi";

/**
 * Crew → ship assignment field (extracted from the old ShipFormModal so the
 * single vessel form, AddVesselModal, can manage crew in edit mode). Regular
 * users must always belong to a ship, so removing an assigned user requires
 * choosing a destination ship.
 */
export interface CrewAssignmentFieldProps {
  crewUsers: UserListItem[];
  crewUsersLoading: boolean;
  currentAssignedUsers: UserListItem[];
  editingShipId: string | null;
  selectedCrewUserIds: string[];
  movedCrewTargets: Record<string, string>;
  shipOptions: Array<{ id: string; name: string }>;
  submitting: boolean;
  onToggleCrewUser: (userId: string) => void;
  onMovedCrewTargetChange: (userId: string, shipId: string) => void;
}

export function CrewAssignmentField({
  crewUsers,
  crewUsersLoading,
  currentAssignedUsers,
  editingShipId,
  selectedCrewUserIds,
  movedCrewTargets,
  shipOptions,
  submitting,
  onToggleCrewUser,
  onMovedCrewTargetChange,
}: CrewAssignmentFieldProps) {
  const selectedUserIds = new Set(selectedCrewUserIds);
  const currentAssignedUserIds = new Set(currentAssignedUsers.map((u) => u.id));
  const currentShipId = editingShipId;
  const transferOptions = shipOptions.filter((ship) => ship.id !== currentShipId);
  const usersNeedingTransfer = currentAssignedUsers.filter(
    (user) => !selectedUserIds.has(user.id),
  );
  const unresolvedTransfers = usersNeedingTransfer.filter(
    (user) => !movedCrewTargets[user.id],
  );
  const sortedCrewUsers = [...crewUsers].sort((left, right) => {
    const la = left.shipId === currentShipId ? 1 : 0;
    const ra = right.shipId === currentShipId ? 1 : 0;
    if (la !== ra) return ra - la;
    const ls = selectedUserIds.has(left.id) ? 1 : 0;
    const rs = selectedUserIds.has(right.id) ? 1 : 0;
    if (ls !== rs) return rs - ls;
    return (left.name ?? left.userId).trim().toLowerCase()
      .localeCompare((right.name ?? right.userId).trim().toLowerCase());
  });

  return (
    <div className="admin-panel__modal-field">
      <div className="admin-panel__field-label-row">
        <label className="admin-panel__field-label">Assigned users</label>
        <span className="admin-panel__muted">{selectedCrewUserIds.length} selected</span>
      </div>

      <div className="admin-panel__ship-crew-panel">
        <p className="admin-panel__muted">
          Regular users must always belong to a ship. When you remove a user from
          this ship, choose where that user should move next.
        </p>

        {crewUsersLoading ? (
          <div className="admin-panel__state-box admin-panel__state-box--compact">
            <div className="admin-panel__spinner" />
            <span className="admin-panel__muted">Loading users...</span>
          </div>
        ) : crewUsers.length === 0 ? (
          <div className="admin-panel__state-box admin-panel__state-box--compact">
            <span className="admin-panel__muted">No regular users are available yet.</span>
          </div>
        ) : (
          <div className="admin-panel__ship-crew-list">
            {sortedCrewUsers.map((user) => {
              const isSelected = selectedUserIds.has(user.id);
              const isAssignedToCurrentShip = currentAssignedUserIds.has(user.id);
              const currentShipLabel = user.ship?.name ?? "No ship assigned";
              return (
                <div key={user.id} className="admin-panel__ship-crew-item">
                  <label className="admin-panel__semantic-checkbox">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleCrewUser(user.id)}
                      disabled={submitting}
                    />
                    <div className="admin-panel__ship-crew-primary">
                      <span className="admin-panel__ship-crew-name">
                        {user.name?.trim() || user.userId}
                      </span>
                      <span className="admin-panel__ship-crew-userid">
                        {user.name?.trim() ? user.userId : "No full name set"}
                      </span>
                    </div>
                  </label>

                  <div className="admin-panel__ship-crew-meta">
                    <span className="admin-panel__ship-crew-badge">
                      Current ship: {currentShipLabel}
                    </span>

                    {currentShipId && isAssignedToCurrentShip && isSelected && (
                      <span className="admin-panel__ship-crew-badge admin-panel__ship-crew-badge--success">
                        Stays on this ship
                      </span>
                    )}

                    {!currentShipId && isSelected && user.ship && (
                      <span className="admin-panel__ship-crew-badge admin-panel__ship-crew-badge--accent">
                        Will move from {user.ship.name}
                      </span>
                    )}

                    {currentShipId && isAssignedToCurrentShip && !isSelected && (
                      <div className="admin-panel__ship-crew-transfer">
                        <span className="admin-panel__muted">
                          Select the ship this user should move to before saving.
                        </span>
                        {transferOptions.length === 0 ? (
                          <div className="admin-panel__input admin-panel__input--full admin-panel__input--disabled-placeholder">
                            Create another ship first
                          </div>
                        ) : (
                          <select
                            className="admin-panel__select admin-panel__input--full"
                            value={movedCrewTargets[user.id] ?? ""}
                            onChange={(e) => onMovedCrewTargetChange(user.id, e.target.value)}
                            disabled={submitting}
                          >
                            <option value="">Select destination ship</option>
                            {transferOptions.map((ship) => (
                              <option key={ship.id} value={ship.id}>{ship.name}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {currentShipId && usersNeedingTransfer.length > 0 && (
          <div className="admin-panel__state-box admin-panel__state-box--compact admin-panel__ship-crew-warning">
            <span className="admin-panel__muted">
              {unresolvedTransfers.length > 0
                ? `Choose destination ships for ${unresolvedTransfers.length} removed user${unresolvedTransfers.length === 1 ? "" : "s"} before saving.`
                : "All removed users now have destination ships selected."}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
