import { fetchWithAuth } from "./core";

export type ShipSummaryItem = {
  id: string;
  name: string;
  organizationName: string | null;
  imoNumber: string | null;
  buildYear: number | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateShipInput = {
  name: string;
  organizationName: string;
  imoNumber?: string | null;
  buildYear?: number | null;
};

export type UpdateShipInput = {
  name?: string;
  organizationName?: string;
  imoNumber?: string | null;
  buildYear?: number | null;
};

export async function getShips(token: string): Promise<ShipSummaryItem[]> {
  const response = await fetchWithAuth("ships", { token });

  if (!response.ok) {
    throw new Error("Failed to fetch ships");
  }

  return response.json();
}

export async function getOrganizations(token: string): Promise<string[]> {
  const response = await fetchWithAuth("ships/organizations", { token });

  if (!response.ok) {
    throw new Error("Failed to fetch organizations");
  }

  return response.json();
}

export async function createShip(
  body: CreateShipInput,
  token: string,
): Promise<ShipSummaryItem> {
  const response = await fetchWithAuth("ships", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to create ship");
  }

  return response.json();
}

export async function getShip(
  id: string,
  token: string,
): Promise<ShipSummaryItem> {
  const response = await fetchWithAuth(`ships/${id}`, { token });

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error("Ship not found");
    }

    throw new Error("Failed to fetch ship");
  }

  return response.json();
}

export async function updateShip(
  id: string,
  body: UpdateShipInput,
  token: string,
): Promise<ShipSummaryItem> {
  const response = await fetchWithAuth(`ships/${id}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to update ship");
  }

  return response.json();
}

export async function deleteShip(id: string, token: string): Promise<void> {
  const response = await fetchWithAuth(`ships/${id}`, {
    token,
    method: "DELETE",
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to delete ship");
  }
}
