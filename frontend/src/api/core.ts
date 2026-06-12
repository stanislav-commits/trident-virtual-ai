const getBaseUrl = () =>
  import.meta.env.VITE_API_URL ?? "http://localhost:3000/api";

export function getApiUrl(path: string): string {
  const base = getBaseUrl().replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

/**
 * Fired when any authenticated request returns 401 — the stored JWT has
 * expired. AuthContext listens and logs the user out (→ login screen)
 * instead of every page silently failing with "Failed to fetch"/401 spam.
 */
export const SESSION_EXPIRED_EVENT = "trident:session-expired";

export async function fetchWithAuth(
  path: string,
  options: RequestInit & { token: string },
): Promise<Response> {
  const { token, ...requestInit } = options;

  const response = await fetch(getApiUrl(path), {
    ...requestInit,
    headers: {
      ...(requestInit.headers as Record<string, string>),
      Authorization: `Bearer ${token}`,
    },
  });

  if (response.status === 401) {
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  }

  return response;
}
