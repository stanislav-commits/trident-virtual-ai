import { createPortal } from "react-dom";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { ShipSummaryItem } from "../../../api/shipsApi";
import type { UserListItem } from "../../../api/usersApi";
import type { ShipFormValues } from "./shipForm";
import { ShipIcon, XIcon } from "../AdminPanelIcons";

interface ShipFormModalProps {
  canSubmit: boolean;
  crewUsers: UserListItem[];
  crewUsersLoading: boolean;
  currentAssignedUsers: UserListItem[];
  editingShip: ShipSummaryItem | null;
  form: ShipFormValues;
  isOpen: boolean;
  movedCrewTargets: Record<string, string>;
  organizations: string[];
  organizationsLoading: boolean;
  selectedCrewUserIds: string[];
  shipOptions: Array<{ id: string; name: string }>;
  submitting: boolean;
  onClose: () => void;
  onFormChange: Dispatch<SetStateAction<ShipFormValues>>;
  onMovedCrewTargetChange: (userId: string, shipId: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  onToggleCrewUser: (userId: string) => void;
}

export function ShipFormModal({
  canSubmit,
  crewUsers,
  crewUsersLoading,
  currentAssignedUsers,
  editingShip,
  form,
  isOpen,
  movedCrewTargets,
  organizations,
  organizationsLoading,
  selectedCrewUserIds,
  shipOptions,
  submitting,
  onClose,
  onFormChange,
  onMovedCrewTargetChange,
  onSubmit,
  onToggleCrewUser,
}: ShipFormModalProps) {
  if (!isOpen) {
    return null;
  }

  const selectedUserIds = new Set(selectedCrewUserIds);
  const currentAssignedUserIds = new Set(currentAssignedUsers.map((user) => user.id));
  const currentShipId = editingShip?.id ?? null;
  const transferOptions = shipOptions.filter((ship) => ship.id !== currentShipId);
  const usersNeedingTransfer = currentAssignedUsers.filter(
    (user) => !selectedUserIds.has(user.id),
  );
  const unresolvedTransfers = usersNeedingTransfer.filter(
    (user) => !movedCrewTargets[user.id],
  );
  const sortedCrewUsers = [...crewUsers].sort((left, right) => {
    const leftAssignedToCurrent = left.shipId === currentShipId ? 1 : 0;
    const rightAssignedToCurrent = right.shipId === currentShipId ? 1 : 0;

    if (leftAssignedToCurrent !== rightAssignedToCurrent) {
      return rightAssignedToCurrent - leftAssignedToCurrent;
    }

    const leftSelected = selectedUserIds.has(left.id) ? 1 : 0;
    const rightSelected = selectedUserIds.has(right.id) ? 1 : 0;

    if (leftSelected !== rightSelected) {
      return rightSelected - leftSelected;
    }

    const leftLabel = (left.name ?? left.userId).trim().toLowerCase();
    const rightLabel = (right.name ?? right.userId).trim().toLowerCase();
    return leftLabel.localeCompare(rightLabel);
  });

  return createPortal(
    <div
      className="admin-panel__modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ap-ship-form-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="admin-panel__modal admin-panel__modal--wide">
        <button
          type="button"
          className="admin-panel__modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          <XIcon />
        </button>

        <div className="admin-panel__modal-head">
          <div className="admin-panel__modal-icon admin-panel__modal-icon--success">
            <ShipIcon />
          </div>
          <h2 id="ap-ship-form-title" className="admin-panel__modal-title">
            {editingShip ? "Edit ship" : "Create ship"}
          </h2>
          <p className="admin-panel__modal-desc">
            {editingShip
              ? "Update the base registry fields for this vessel and manage which regular users are attached to it."
              : "Register the vessel first, then optionally attach existing regular users to it right away."}
          </p>
        </div>

        <form onSubmit={onSubmit} className="admin-panel__modal-form">
          <div className="admin-panel__modal-field">
            <label className="admin-panel__field-label">Ship name</label>
            <input
              type="text"
              className="admin-panel__input admin-panel__input--full"
              value={form.name}
              onChange={(event) =>
                onFormChange((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder="e.g. Ocean Explorer"
              required
              disabled={submitting}
              autoFocus={!editingShip}
            />
          </div>

          <div className="admin-panel__modal-field">
            <label className="admin-panel__field-label">Organization</label>
            <select
              className="admin-panel__input admin-panel__input--full"
              value={form.organizationName}
              onChange={(event) =>
                onFormChange((current) => ({
                  ...current,
                  organizationName: event.target.value,
                }))
              }
              required
              disabled={submitting || organizationsLoading}
            >
              <option value="">
                {organizationsLoading
                  ? "Loading organizations..."
                  : organizations.length
                    ? "Select an organization"
                    : "No organizations available"}
              </option>
              {organizations.map((organization) => (
                <option key={organization} value={organization}>
                  {organization}
                </option>
              ))}
            </select>
          </div>

          <div className="admin-panel__modal-field-row">
            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">IMO number</label>
              <input
                type="text"
                className="admin-panel__input admin-panel__input--full"
                value={form.imoNumber}
                onChange={(event) =>
                  onFormChange((current) => ({
                    ...current,
                    imoNumber: event.target.value,
                  }))
                }
                placeholder="e.g. 9781234"
                disabled={submitting}
              />
            </div>

            <div className="admin-panel__modal-field">
              <label className="admin-panel__field-label">Build year</label>
              <input
                type="number"
                min="1800"
                max="3000"
                step="1"
                inputMode="numeric"
                className="admin-panel__input admin-panel__input--full"
                value={form.buildYear}
                onChange={(event) =>
                  onFormChange((current) => ({
                    ...current,
                    buildYear: event.target.value,
                  }))
                }
                placeholder="e.g. 2018"
                disabled={submitting}
              />
            </div>
          </div>

          <div className="admin-panel__modal-field">
            <div className="admin-panel__field-label-row">
              <label className="admin-panel__field-label">Assigned users</label>
              <span className="admin-panel__muted">
                {selectedCrewUserIds.length} selected
              </span>
            </div>

            <div className="admin-panel__ship-crew-panel">
              <p className="admin-panel__muted">
                Regular users must always belong to a ship. When you remove a
                user from this ship during edit, choose where that user should
                move next.
              </p>

              {crewUsersLoading ? (
                <div className="admin-panel__state-box admin-panel__state-box--compact">
                  <div className="admin-panel__spinner" />
                  <span className="admin-panel__muted">Loading users...</span>
                </div>
              ) : crewUsers.length === 0 ? (
                <div className="admin-panel__state-box admin-panel__state-box--compact">
                  <span className="admin-panel__muted">
                    No regular users are available yet.
                  </span>
                </div>
              ) : (
                <div className="admin-panel__ship-crew-list">
                  {sortedCrewUsers.map((user) => {
                    const isSelected = selectedUserIds.has(user.id);
                    const isAssignedToCurrentShip = currentAssignedUserIds.has(
                      user.id,
                    );
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

                          {currentShipId &&
                            isAssignedToCurrentShip &&
                            !isSelected && (
                              <div className="admin-panel__ship-crew-transfer">
                                <span className="admin-panel__muted">
                                  Select the ship this user should move to before
                                  saving.
                                </span>

                                {transferOptions.length === 0 ? (
                                  <div className="admin-panel__input admin-panel__input--full admin-panel__input--disabled-placeholder">
                                    Create another ship first
                                  </div>
                                ) : (
                                  <select
                                    className="admin-panel__select admin-panel__input--full"
                                    value={movedCrewTargets[user.id] ?? ""}
                                    onChange={(event) =>
                                      onMovedCrewTargetChange(
                                        user.id,
                                        event.target.value,
                                      )
                                    }
                                    disabled={submitting}
                                  >
                                    <option value="">Select destination ship</option>
                                    {transferOptions.map((ship) => (
                                      <option key={ship.id} value={ship.id}>
                                        {ship.name}
                                      </option>
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

              {editingShip && usersNeedingTransfer.length > 0 && (
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

          {!organizationsLoading && organizations.length === 0 && (
            <div className="admin-panel__modal-footer">
              <span className="admin-panel__muted">
                Organizations are currently unavailable. Check the Influx
                integration.
              </span>
            </div>
          )}

          <div className="admin-panel__modal-actions">
            <button
              type="button"
              className="admin-panel__btn admin-panel__btn--ghost"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="admin-panel__btn admin-panel__btn--primary"
              disabled={!canSubmit}
            >
              {submitting
                ? editingShip
                  ? "Saving..."
                  : "Creating..."
                : editingShip
                  ? "Save changes"
                  : "Create ship"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
