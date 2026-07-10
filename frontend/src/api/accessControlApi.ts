import { fetchWithAuth } from "./core";

export type PermissionLevel = "none" | "read" | "write";

export interface AccessPositionMeta {
  value: string;
  label: string;
  department: string | null;
}
export interface DepartmentMeta {
  key: string;
  label: string;
}
export interface ResourceCategoryMeta {
  value: string;
  label: string;
}

/** THE single taxonomy the admin UI renders from (positions, departments, categories). */
export interface AccessSchema {
  positions: AccessPositionMeta[];
  departments: DepartmentMeta[];
  resourceCategories: ResourceCategoryMeta[];
  levels: PermissionLevel[];
}

export type AccessMatrix = Record<string, Record<string, PermissionLevel>>;

export interface MyAccess {
  restricted: boolean;
  position: string | null;
  permissions: Record<string, PermissionLevel> | null;
}

export async function getMyAccess(token: string): Promise<MyAccess> {
  const res = await fetchWithAuth("access-control/me", { token });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? "Failed to load access");
  }
  return res.json();
}

/** True when the viewer may at least read a category (unrestricted → always). */
export function canRead(access: MyAccess | null, category: string): boolean {
  if (!access || !access.restricted || !access.permissions) return true;
  return access.permissions[category] !== "none";
}

export async function getAccessSchema(token: string): Promise<AccessSchema> {
  const res = await fetchWithAuth("access-control/schema", { token });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? "Failed to load access schema");
  }
  return res.json();
}

export async function getAccessMatrix(
  token: string,
  shipId: string,
): Promise<AccessMatrix> {
  const res = await fetchWithAuth(`access-control/matrix/${shipId}`, { token });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? "Failed to load access matrix");
  }
  return res.json();
}

export async function setAccessCell(
  token: string,
  shipId: string,
  position: string,
  resourceCategory: string,
  level: PermissionLevel,
): Promise<AccessMatrix> {
  const res = await fetchWithAuth(`access-control/matrix/${shipId}/cell`, {
    token,
    method: "PUT",
    body: JSON.stringify({ position, resourceCategory, level }),
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message ?? "Failed to update permission");
  }
  return res.json();
}
