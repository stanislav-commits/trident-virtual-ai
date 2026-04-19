import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { ShipSummaryItem } from "../../api/shipsApi";
import {
  createEmptyShipForm,
  createShipFormFromShip,
  type ShipFormValues,
} from "../../components/admin/ships/shipForm";

export interface ShipFormState {
  showFormModal: boolean;
  editingShipId: string | null;
  shipForm: ShipFormValues;
  editingShip: ShipSummaryItem | null;
  openCreateModal: () => void;
  openEditModal: (ship: ShipSummaryItem) => void;
  closeFormModal: (isSubmitting?: boolean) => void;
  setShipForm: Dispatch<SetStateAction<ShipFormValues>>;
  resetShipForm: () => void;
}

export function useShipForm(ships: ShipSummaryItem[]): ShipFormState {
  const [showFormModal, setShowFormModal] = useState(false);
  const [editingShipId, setEditingShipId] = useState<string | null>(null);
  const [shipForm, setShipForm] = useState<ShipFormValues>(createEmptyShipForm);

  const editingShip = useMemo(
    () => ships.find((ship) => ship.id === editingShipId) ?? null,
    [editingShipId, ships],
  );

  const openCreateModal = () => {
    setEditingShipId(null);
    setShipForm(createEmptyShipForm());
    setShowFormModal(true);
  };

  const openEditModal = (ship: ShipSummaryItem) => {
    setEditingShipId(ship.id);
    setShipForm(createShipFormFromShip(ship));
    setShowFormModal(true);
  };

  const closeFormModal = (isSubmitting = false) => {
    if (isSubmitting) {
      return;
    }

    setShowFormModal(false);
    setEditingShipId(null);
    setShipForm(createEmptyShipForm());
  };

  const resetShipForm = () => {
    setShowFormModal(false);
    setEditingShipId(null);
    setShipForm(createEmptyShipForm());
  };

  return {
    showFormModal,
    editingShipId,
    shipForm,
    editingShip,
    openCreateModal,
    openEditModal,
    closeFormModal,
    setShipForm,
    resetShipForm,
  };
}
