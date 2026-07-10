import { fetchWithAuth, ok } from "./core";

export const INVENTORY_CATEGORIES = [
  "part",
  "tool",
  "fluid",
  "consumable",
  "other",
] as const;

/** Units of measure offered in the "Add part" form. */
export const INVENTORY_UNITS = [
  "pcs",
  "set",
  "kit",
  "pair",
  "box",
  "roll",
  "L",
  "ml",
  "kg",
  "g",
  "m",
  "cm",
] as const;

export interface InventoryLink {
  id: string;
  name: string;
}
export type InventoryAssetLink = InventoryLink;

export interface InventoryItem {
  id: string;
  name: string;
  category: string;
  partNumber?: string;
  location?: string;
  manufacturer?: string;
  supplier?: string;
  quantity?: number;
  unit?: string;
  assetIds: string[];
  assets: InventoryLink[];
  taskIds: string[];
  tasks: InventoryLink[];
  notes?: string;
}

export interface UpsertInventoryInput {
  name: string;
  category?: string;
  partNumber?: string | null;
  location?: string | null;
  manufacturer?: string | null;
  supplier?: string | null;
  quantity?: number | null;
  unit?: string | null;
  assetIds?: string[] | null;
  taskIds?: string[] | null;
  notes?: string | null;
}

export interface InventoryDraft {
  name: string;
  category?: string;
  partNumber?: string | null;
  manufacturer?: string | null;
  supplier?: string | null;
  quantity?: number | null;
  unit?: string | null;
  location?: string | null;
  notes?: string | null;
  assetIds?: string[] | null;
}

export async function listInventory(
  token: string,
  shipId: string,
): Promise<InventoryItem[]> {
  const r = await fetchWithAuth(`ships/${shipId}/inventory`, { token });
  await ok(r, "Load inventory");
  return r.json();
}

export async function listAssetInventory(
  token: string,
  shipId: string,
  assetId: string,
): Promise<InventoryItem[]> {
  const r = await fetchWithAuth(`ships/${shipId}/inventory/assets/${assetId}`, {
    token,
  });
  await ok(r, "Load asset inventory");
  return r.json();
}

export async function listTaskInventory(
  token: string,
  shipId: string,
  taskId: string,
): Promise<InventoryItem[]> {
  const r = await fetchWithAuth(`ships/${shipId}/inventory/tasks/${taskId}`, {
    token,
  });
  await ok(r, "Load task parts");
  return r.json();
}

/** Set the full set of parts linked to a task (from the task's parts panel). */
export async function setTaskParts(
  token: string,
  shipId: string,
  taskId: string,
  itemIds: string[],
): Promise<void> {
  const r = await fetchWithAuth(
    `ships/${shipId}/inventory/tasks/${taskId}/parts`,
    {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemIds }),
    },
  );
  await ok(r, "Link parts to task");
}

export async function createInventoryItem(
  token: string,
  shipId: string,
  input: UpsertInventoryInput,
): Promise<InventoryItem> {
  const r = await fetchWithAuth(`ships/${shipId}/inventory`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ok(r, "Create item");
  return r.json();
}

export async function updateInventoryItem(
  token: string,
  shipId: string,
  id: string,
  input: Partial<UpsertInventoryInput>,
): Promise<InventoryItem> {
  const r = await fetchWithAuth(`ships/${shipId}/inventory/${id}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ok(r, "Update item");
  return r.json();
}

export async function deleteInventoryItem(
  token: string,
  shipId: string,
  id: string,
): Promise<void> {
  const r = await fetchWithAuth(`ships/${shipId}/inventory/${id}`, {
    token,
    method: "DELETE",
  });
  await ok(r, "Delete item");
}

export async function suggestInventoryFromManual(
  token: string,
  shipId: string,
  assetId: string,
  text: string,
): Promise<{ drafts: InventoryDraft[]; notes: string[] }> {
  const r = await fetchWithAuth(
    `ships/${shipId}/inventory/assets/${assetId}/suggest`,
    {
      token,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    },
  );
  await ok(r, "Suggest parts");
  return r.json();
}

export async function commitInventory(
  token: string,
  shipId: string,
  drafts: InventoryDraft[],
): Promise<{ created: number }> {
  const r = await fetchWithAuth(`ships/${shipId}/inventory/commit`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ drafts }),
  });
  await ok(r, "Import parts");
  return r.json();
}
