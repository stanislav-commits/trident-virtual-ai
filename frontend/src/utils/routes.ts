export type AdminSectionRoute = "overview" | "users" | "ships" | "assets" | "documents" | "metrics" | "compliance" | "maintenance" | "tasks" | "crew" | "inventory" | "alerts" | "publications";

/**
 * Landing section for the admin panel (entering from chat or bare /admin).
 * Overview, so that arriving here starts with what needs attention rather than
 * with a register of 1500 rows. Note this also retargets the "Admin panel"
 * button in the chat topbar and the redirect from a bare /admin.
 */
export const defaultAdminSection: AdminSectionRoute = "overview";

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
  "overview",
  "compliance",
  "users",
  "ships",
  "assets",
  "documents",
  "metrics",
  "maintenance",
  "tasks",
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
