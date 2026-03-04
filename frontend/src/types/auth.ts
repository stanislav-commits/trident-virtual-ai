export type Role = "admin" | "user";

export interface AuthUser {
  id: string;
  userId: string;
  role: Role;
  shipId?: string | null;
  name?: string | null;
}

export interface LoginResponse {
  access_token: string;
  user: AuthUser;
}
