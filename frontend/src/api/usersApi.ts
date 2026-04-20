import { fetchWithAuth } from "./core";

export type UserListItem = {
  id: string;
  userId: string;
  name: string | null;
  role: "admin" | "user";
  shipId: string | null;
  createdAt: string;
  ship: { id: string; name: string } | null;
};

export type CreateUserResult = {
  id: string;
  userId: string;
  password: string;
};

export async function getUsers(token: string): Promise<UserListItem[]> {
  const response = await fetchWithAuth("users", { token });

  if (!response.ok) {
    throw new Error("Failed to fetch users");
  }

  return response.json();
}

export async function createUser(
  role: "admin" | "user",
  token: string,
  shipId?: string,
  name?: string,
): Promise<CreateUserResult> {
  const response = await fetchWithAuth("users", {
    token,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      role,
      shipId,
      name: name?.trim() || undefined,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to create user");
  }

  return response.json();
}

export async function resetPassword(
  id: string,
  token: string,
): Promise<{ userId: string; password: string }> {
  const response = await fetchWithAuth(`users/${id}/reset-password`, {
    token,
    method: "PATCH",
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to reset password");
  }

  return response.json();
}

export async function deleteUser(id: string, token: string): Promise<void> {
  const response = await fetchWithAuth(`users/${id}`, {
    token,
    method: "DELETE",
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to delete user");
  }
}

export async function updateUserName(
  id: string,
  name: string,
  token: string,
): Promise<{ id: string; userId: string; name: string | null }> {
  const response = await fetchWithAuth(`users/${id}/name`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to update user name");
  }

  return response.json();
}

export async function updateUserShip(
  id: string,
  shipId: string,
  token: string,
): Promise<{
  id: string;
  userId: string;
  shipId: string | null;
  ship: { id: string; name: string };
}> {
  const response = await fetchWithAuth(`users/${id}/ship`, {
    token,
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shipId }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Failed to update user ship");
  }

  return response.json();
}
