export type AdminSectionRoute = "users" | "ships" | "assets" | "documents" | "metrics" | "compliance" | "maintenance" | "crew" | "inventory" | "alerts" | "publications";

export const appRoutes = {
  root: "/",
  login: "/login",
  privacy: "/privacy",
  home: "/home",
  chats: "/chats",
  chatSessionPattern: "/chats/:sessionId",
  chatSession: (sessionId: string) => `/chats/${sessionId}`,
  dataset: "/dataset",
  admin: "/admin",
  adminSectionPattern: "/admin/:section",
  adminSection: (section: AdminSectionRoute) => `/admin/${section}`,
} as const;

const adminSections = new Set<AdminSectionRoute>([
  "compliance",
  "users",
  "ships",
  "assets",
  "documents",
  "metrics",
  "maintenance",
  "crew",
  "inventory",
  "alerts",
  "publications",
]);

export function isAdminSectionRoute(
  value: string | undefined,
): value is AdminSectionRoute {
  if (!value) {
    return false;
  }

  return adminSections.has(value as AdminSectionRoute);
}
