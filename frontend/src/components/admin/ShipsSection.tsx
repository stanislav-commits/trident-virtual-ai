import { useMemo, useState } from "react";
import {
  createShip,
  updateShip,
  type ShipSummaryItem,
} from "../../api/shipsApi";
import { useShipForm } from "../../hooks/admin/useShipForm";
import { PlusIcon } from "./AdminPanelIcons";
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

  const canSubmitShip =
    Boolean(token) &&
    !submittingShip &&
    !organizationsLoading &&
    availableOrganizations.length > 0;

  const openCreateModal = () => {
    onError("");
    openCreateState();
  };

  const openEditModal = (ship: ShipSummaryItem) => {
    onError("");
    openEditState(ship);
  };

  const closeFormModal = () => {
    closeFormState(submittingShip);
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
        await createShip(payload, token);
      }

      resetShipForm();
      await onLoadShips();
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
            onClick={openCreateModal}
          >
            <PlusIcon /> Add ship
          </button>
        </div>

        {error && (
          <div className="admin-panel__error" role="alert">
            {error}
          </div>
        )}

        <ShipsTable ships={ships} loading={loading} onEdit={openEditModal} />
      </section>

      <ShipFormModal
        canSubmit={canSubmitShip}
        editingShip={editingShip}
        form={shipForm}
        isOpen={showFormModal}
        organizations={availableOrganizations}
        organizationsLoading={organizationsLoading}
        submitting={submittingShip}
        onClose={closeFormModal}
        onFormChange={setShipForm}
        onSubmit={handleShipSubmit}
      />
    </>
  );
}
