import type { ShipSummaryItem } from "../../../api/shipsApi";

export interface ShipFormValues {
  name: string;
  organizationName: string;
  imoNumber: string;
  buildYear: string;
}

export function createEmptyShipForm(): ShipFormValues {
  return {
    name: "",
    organizationName: "",
    imoNumber: "",
    buildYear: "",
  };
}

export function createShipFormFromShip(ship: ShipSummaryItem): ShipFormValues {
  return {
    name: ship.name,
    organizationName: ship.organizationName ?? "",
    imoNumber: ship.imoNumber ?? "",
    buildYear: ship.buildYear != null ? String(ship.buildYear) : "",
  };
}

export function normalizeOptionalText(value: string): string | null {
  const normalizedValue = value.trim();
  return normalizedValue ? normalizedValue : null;
}

export function normalizeOptionalYear(value: string): number | null {
  const normalizedValue = value.trim();

  if (!normalizedValue || !/^\d+$/.test(normalizedValue)) {
    return null;
  }

  const parsedValue = Number(normalizedValue);
  return Number.isSafeInteger(parsedValue) ? parsedValue : null;
}
