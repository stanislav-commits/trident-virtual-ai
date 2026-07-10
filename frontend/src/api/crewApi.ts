import { fetchWithAuth, ok } from "./core";

export interface CrewMemberDto {
  id: string;
  name: string;
  department: string;
  rank: string;
  rankLevel: number;
  email?: string;
  phone?: string;
  active: boolean;
  joinedAt?: string;
  notes?: string;
  // login linkage
  hasLogin: boolean;
  loginUserId: string | null;
}

export interface LoginCredentials {
  userId: string;
  password: string;
}

export interface UpsertCrewInput {
  name: string;
  department?: string;
  rank?: string;
  rankLevel?: number | null;
  email?: string | null;
  phone?: string | null;
  active?: boolean;
  joinedAt?: string | null;
  notes?: string | null;
}

export interface RankDef {
  rank: string;
  level: number;
}
export interface DepartmentDef {
  key: string;
  label: string;
  ranks: RankDef[];
}

export async function fetchCrewCatalog(
  token: string,
  shipId: string,
): Promise<DepartmentDef[]> {
  const r = await fetchWithAuth(`ships/${shipId}/crew/catalog`, { token });
  await ok(r, "Load crew catalog");
  return (await r.json()).departments as DepartmentDef[];
}

export async function listCrew(
  token: string,
  shipId: string,
): Promise<CrewMemberDto[]> {
  const r = await fetchWithAuth(`ships/${shipId}/crew`, { token });
  await ok(r, "Load crew");
  return r.json();
}

export async function createCrew(
  token: string,
  shipId: string,
  input: UpsertCrewInput,
): Promise<CrewMemberDto> {
  const r = await fetchWithAuth(`ships/${shipId}/crew`, {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ok(r, "Create crew member");
  return r.json();
}

export async function updateCrew(
  token: string,
  shipId: string,
  id: string,
  input: Partial<UpsertCrewInput>,
): Promise<CrewMemberDto> {
  const r = await fetchWithAuth(`ships/${shipId}/crew/${id}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ok(r, "Update crew member");
  return r.json();
}

export async function deleteCrew(
  token: string,
  shipId: string,
  id: string,
): Promise<void> {
  const r = await fetchWithAuth(`ships/${shipId}/crew/${id}`, {
    token,
    method: "DELETE",
  });
  await ok(r, "Delete crew member");
}

// ── login provisioning ──

export async function createCrewLogin(
  token: string,
  shipId: string,
  id: string,
): Promise<LoginCredentials> {
  const r = await fetchWithAuth(`ships/${shipId}/crew/${id}/login`, {
    token,
    method: "POST",
  });
  await ok(r, "Create login");
  return r.json();
}

export async function resetCrewLogin(
  token: string,
  shipId: string,
  id: string,
): Promise<LoginCredentials> {
  const r = await fetchWithAuth(`ships/${shipId}/crew/${id}/login/reset`, {
    token,
    method: "PATCH",
  });
  await ok(r, "Reset password");
  return r.json();
}

export async function revokeCrewLogin(
  token: string,
  shipId: string,
  id: string,
): Promise<void> {
  const r = await fetchWithAuth(`ships/${shipId}/crew/${id}/login`, {
    token,
    method: "DELETE",
  });
  await ok(r, "Revoke login");
}
