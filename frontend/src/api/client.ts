import type { AuthUser } from "../types/auth";

const getBaseUrl = () =>
  import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export function getApiUrl(path: string): string {
  const base = getBaseUrl().replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

export async function login(userId: string, password: string) {
  const res = await fetch(getApiUrl("auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Login failed");
  }
  return res.json() as Promise<{ access_token: string; user: AuthUser }>;
}

export async function fetchWithAuth(
  path: string,
  options: RequestInit & { token: string },
): Promise<Response> {
  const { token, ...init } = options;
  return fetch(getApiUrl(path), {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      Authorization: `Bearer ${token}`,
    },
  });
}

export type UserListItem = {
  id: string;
  userId: string;
  name?: string | null;
  role: string;
  shipId: string | null;
  createdAt: string;
  ship?: { id: string; name: string } | null;
};

export async function getUsers(token: string): Promise<UserListItem[]> {
  const res = await fetchWithAuth("users", { token });
  if (!res.ok) throw new Error("Failed to fetch users");
  return res.json();
}

export async function createUser(
  role: "user" | "admin",
  token: string,
  shipId?: string,
  name?: string,
): Promise<{ id: string; userId: string; password: string }> {
  const body: Record<string, unknown> = { role };
  if (shipId) body.shipId = shipId;
  if (name?.trim()) body.name = name.trim();
  const res = await fetchWithAuth("users", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to create user");
  }
  return res.json();
}

export async function resetPassword(
  id: string,
  token: string,
): Promise<{ userId: string; password: string }> {
  const res = await fetchWithAuth(`users/${id}/reset-password`, {
    token,
    method: "PATCH",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to reset password");
  }
  return res.json();
}

export async function deleteUser(id: string, token: string): Promise<void> {
  const res = await fetchWithAuth(`users/${id}`, {
    token,
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to delete user");
  }
}

export async function updateUserName(
  id: string,
  name: string,
  token: string,
): Promise<{ id: string; userId: string; name: string | null }> {
  const res = await fetchWithAuth(`users/${id}/name`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() || null }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to update user name");
  }
  return res.json();
}

export type MetricDefinitionItem = {
  key: string;
  label: string;
  description: string | null;
  unit: string | null;
  dataType: string;
  bucket?: string | null;
  measurement?: string | null;
  field?: string | null;
  status?: string | null;
  createdAt?: string;
};

export type ShipMetricsConfigItem = {
  metricKey: string;
  isActive: boolean;
  metric?: { key: string; label: string; unit: string | null };
};

export type ShipAssignedUserItem = {
  id: string;
  userId: string;
  name?: string | null;
};

export type ShipManualItem = {
  id: string;
  ragflowDocumentId: string;
  filename: string;
  uploadedAt: string;
};

export type ManualStatusItem = ShipManualItem & {
  run: string | null;
  progress: number | null;
  progressMsg: string | null;
  chunkCount: number | null;
};

export type ShipListItem = {
  id: string;
  name: string;
  organizationName: string | null;
  imoNumber: string | null;
  flag: string | null;
  deadweight: number | null;
  grossTonnage: number | null;
  buildYard: string | null;
  shipClass: string | null;
  metricsSyncStatus: string;
  metricsSyncError: string | null;
  metricsSyncedAt: string | null;
  lastTelemetry: Record<string, unknown>;
  updatedAt: string;
  metricsConfig: ShipMetricsConfigItem[];
  assignedUsers: ShipAssignedUserItem[];
  ragflowDatasetId?: string | null;
  manuals?: ShipManualItem[];
};

export async function getMetricDefinitions(
  token: string,
): Promise<MetricDefinitionItem[]> {
  const res = await fetchWithAuth("ships/metric-definitions", { token });
  if (!res.ok) throw new Error("Failed to fetch metric definitions");
  return res.json();
}

export async function getOrganizations(token: string): Promise<string[]> {
  const res = await fetchWithAuth("ships/organizations", { token });
  if (!res.ok) throw new Error("Failed to fetch organizations");
  return res.json();
}

export async function getMetrics(
  token: string,
): Promise<MetricDefinitionItem[]> {
  const res = await fetchWithAuth("metrics", { token });
  if (!res.ok) throw new Error("Failed to fetch metrics");
  return res.json();
}

export type CreateMetricBody = {
  key: string;
  label: string;
  description?: string;
  unit?: string;
  dataType?: string;
};

export async function createMetric(
  body: CreateMetricBody,
  token: string,
): Promise<MetricDefinitionItem> {
  const res = await fetchWithAuth("metrics", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to create metric");
  }
  return res.json();
}

export type UpdateMetricBody = {
  label?: string;
  description?: string;
  unit?: string;
  dataType?: string;
};

export async function updateMetric(
  key: string,
  body: UpdateMetricBody,
  token: string,
): Promise<MetricDefinitionItem> {
  const res = await fetchWithAuth(`metrics/${encodeURIComponent(key)}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to update metric");
  }
  return res.json();
}

export async function deleteMetric(key: string, token: string): Promise<void> {
  const res = await fetchWithAuth(`metrics/${encodeURIComponent(key)}`, {
    token,
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to delete metric");
  }
}

export async function getShips(token: string): Promise<ShipListItem[]> {
  const res = await fetchWithAuth("ships", { token });
  if (!res.ok) throw new Error("Failed to fetch ships");
  return res.json();
}

export async function createShip(
  body: {
    name: string;
    organizationName: string;
    imoNumber?: string | null;
    flag?: string | null;
    deadweight?: number | null;
    grossTonnage?: number | null;
    buildYard?: string | null;
    shipClass?: string | null;
    metricKeys?: string[];
    userIds?: string[];
  },
  token: string,
): Promise<ShipListItem> {
  const res = await fetchWithAuth("ships", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to create ship");
  }
  return res.json();
}

export async function getShip(
  id: string,
  token: string,
): Promise<ShipListItem> {
  const res = await fetchWithAuth(`ships/${id}`, { token });
  if (!res.ok) {
    if (res.status === 404) throw new Error("Ship not found");
    throw new Error("Failed to fetch ship");
  }
  return res.json();
}

export async function updateShip(
  id: string,
  body: {
    name?: string;
    organizationName?: string;
    imoNumber?: string | null;
    flag?: string | null;
    deadweight?: number | null;
    grossTonnage?: number | null;
    buildYard?: string | null;
    shipClass?: string | null;
    metricKeys?: string[];
    userIds?: string[];
  },
  token: string,
): Promise<ShipListItem> {
  const res = await fetchWithAuth(`ships/${id}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to update ship");
  }
  return res.json();
}

export async function updateShipMetricActivity(
  id: string,
  metricKeys: string[],
  token: string,
): Promise<ShipListItem> {
  return updateShip(
    id,
    {
      metricKeys,
    },
    token,
  );
}

export async function deleteShip(id: string, token: string): Promise<void> {
  const res = await fetchWithAuth(`ships/${id}`, {
    token,
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to delete ship");
  }
}

export async function uploadManual(
  shipId: string,
  file: File,
  token: string,
): Promise<ShipManualItem | ShipManualItem[]> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetchWithAuth(`ships/${shipId}/manuals`, {
    token,
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to upload manual");
  }
  return res.json();
}

export async function getManuals(
  shipId: string,
  token: string,
): Promise<ShipManualItem[]> {
  const res = await fetchWithAuth(`ships/${shipId}/manuals`, { token });
  if (!res.ok) throw new Error("Failed to fetch manuals");
  return res.json();
}

export async function getManualsStatus(
  shipId: string,
  token: string,
): Promise<ManualStatusItem[]> {
  const res = await fetchWithAuth(`ships/${shipId}/manuals/status`, { token });
  if (!res.ok) throw new Error("Failed to fetch manuals status");
  return res.json();
}

export async function deleteManual(
  shipId: string,
  manualId: string,
  token: string,
): Promise<void> {
  const res = await fetchWithAuth(`ships/${shipId}/manuals/${manualId}`, {
    token,
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to delete manual");
  }
}

export async function updateManual(
  shipId: string,
  manualId: string,
  body: { filename?: string },
  token: string,
): Promise<ShipManualItem> {
  const res = await fetchWithAuth(`ships/${shipId}/manuals/${manualId}`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? "Failed to update manual");
  }
  return res.json();
}
