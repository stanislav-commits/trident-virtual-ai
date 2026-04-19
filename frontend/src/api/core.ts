const getBaseUrl = () =>
  import.meta.env.VITE_API_URL ?? "http://localhost:3000/api";

export function getApiUrl(path: string): string {
  const base = getBaseUrl().replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

export async function fetchWithAuth(
  path: string,
  options: RequestInit & { token: string },
): Promise<Response> {
  const { token, ...requestInit } = options;

  return fetch(getApiUrl(path), {
    ...requestInit,
    headers: {
      ...(requestInit.headers as Record<string, string>),
      Authorization: `Bearer ${token}`,
    },
  });
}
