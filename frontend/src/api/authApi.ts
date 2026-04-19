import type { AuthUser } from "../types/auth";
import { getApiUrl } from "./core";

export interface LoginResponse {
  access_token: string;
  user: AuthUser;
}

export async function login(
  userId: string,
  password: string,
): Promise<LoginResponse> {
  const response = await fetch(getApiUrl("auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, password }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    throw new Error(errorBody.message ?? "Login failed");
  }

  return response.json();
}
