import type { AuthUser } from '../types/auth';

const getBaseUrl = () => import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

export function getApiUrl(path: string): string {
  const base = getBaseUrl().replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

export async function login(userId: string, password: string) {
  const res = await fetch(getApiUrl('auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? 'Login failed');
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
  role: string;
  createdAt: string;
};

export async function getUsers(token: string): Promise<UserListItem[]> {
  const res = await fetchWithAuth('users', { token });
  if (!res.ok) throw new Error('Failed to fetch users');
  return res.json();
}

export async function createUser(
  role: 'user' | 'admin',
  token: string,
): Promise<{ id: string; userId: string; password: string }> {
  const res = await fetchWithAuth('users', {
    token,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? 'Failed to create user');
  }
  return res.json();
}

export async function resetPassword(
  id: string,
  token: string,
): Promise<{ userId: string; password: string }> {
  const res = await fetchWithAuth(`users/${id}/reset-password`, {
    token,
    method: 'PATCH',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? 'Failed to reset password');
  }
  return res.json();
}

export async function deleteUser(id: string, token: string): Promise<void> {
  const res = await fetchWithAuth(`users/${id}`, {
    token,
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? 'Failed to delete user');
  }
}

export type MetricDefinitionItem = {
  key: string;
  label: string;
  unit: string | null;
  dataType: string;
};

export type ShipMetricsConfigItem = {
  metricKey: string;
  isActive: boolean;
  metric?: { key: string; label: string; unit: string | null };
};

export type ShipListItem = {
  id: string;
  name: string;
  serialNumber: string | null;
  lastTelemetry: Record<string, unknown>;
  updatedAt: string;
  metricsConfig: ShipMetricsConfigItem[];
};

export async function getMetricDefinitions(
  token: string,
): Promise<MetricDefinitionItem[]> {
  const res = await fetchWithAuth('ships/metric-definitions', { token });
  if (!res.ok) throw new Error('Failed to fetch metric definitions');
  return res.json();
}

export async function getShips(token: string): Promise<ShipListItem[]> {
  const res = await fetchWithAuth('ships', { token });
  if (!res.ok) throw new Error('Failed to fetch ships');
  return res.json();
}

export async function createShip(
  body: { name: string; serialNumber?: string; metricKeys: string[] },
  token: string,
): Promise<ShipListItem> {
  const res = await fetchWithAuth('ships', {
    token,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? 'Failed to create ship');
  }
  return res.json();
}

export async function getShip(
  id: string,
  token: string,
): Promise<ShipListItem> {
  const res = await fetchWithAuth(`ships/${id}`, { token });
  if (!res.ok) {
    if (res.status === 404) throw new Error('Ship not found');
    throw new Error('Failed to fetch ship');
  }
  return res.json();
}

export async function updateShip(
  id: string,
  body: { name?: string; serialNumber?: string | null; metricKeys?: string[] },
  token: string,
): Promise<ShipListItem> {
  const res = await fetchWithAuth(`ships/${id}`, {
    token,
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? 'Failed to update ship');
  }
  return res.json();
}

export async function deleteShip(id: string, token: string): Promise<void> {
  const res = await fetchWithAuth(`ships/${id}`, {
    token,
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message ?? 'Failed to delete ship');
  }
}
