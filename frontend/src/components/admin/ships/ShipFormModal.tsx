import { createPortal } from "react-dom";
import type { Dispatch, FormEvent, SetStateAction } from "react";
import type { ShipSummaryItem } from "../../../api/shipsApi";
import type { ShipFormValues } from "./shipForm";
import { ShipIcon, XIcon } from "../AdminPanelIcons";

interface ShipFormModalProps {
  canSubmit: boolean;
  editingShip: ShipSummaryItem | null;
  form: ShipFormValues;
  isOpen: boolean;
  organizations: string[];
  organizationsLoading: boolean;
  submitting: boolean;
  onClose: () => void;
  onFormChange: Dispatch<SetStateAction<ShipFormValues>>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
}

export function ShipFormModal({
  canSubmit,
  editingShip,
  form,
  isOpen,
  organizations,
  organizationsLoading,
  submitting,
  onClose,
  onFormChange,
  onSubmit,
}: ShipFormModalProps) {
  if (!isOpen) {
    return null;
  }

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
              ? "Update the base registry fields for this vessel."
              : "Register the vessel first. Metrics, manuals, and additional configuration will stay in their own flows."}
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
