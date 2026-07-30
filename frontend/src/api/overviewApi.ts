import { fetchWithAuth, ok } from "./core";
import type { OverviewTokens, ShipOverviewResponse } from "../types/overview";

/**
 * The contract itself lives in `types/overview.ts` (mirror of
 * backend/src/modules/overview/overview.types.ts) and is re-exported here so a
 * section can import the call and its types from one place — a second copy of
 * the shape would drift away from the server the first time a card changes.
 */
export type {
  OverviewCard,
  OverviewTokens,
  OverviewCardDegraded,
  OverviewStat,
  OverviewStatTone,
  OverviewVessel,
  ShipOverviewResponse,
} from "../types/overview";

export async function getShipOverview(
  token: string,
  shipId: string,
): Promise<ShipOverviewResponse> {
  const r = await fetchWithAuth(`ships/${shipId}/overview`, { token });
  await ok(r, "Load overview");
  return r.json();
}

/**
 * Spend for a window the operator picked. `from`/`to` are calendar days and `to`
 * is inclusive — the server adds the day, so "1 to 31 July" covers the 31st.
 * Both omitted means month to date, the same figure the page loads with.
 */
export interface SpendFilter {
  model?: string;
  purpose?: string;
  /** A user id, or "none" for the calls no person initiated. */
  user?: string;
}

export async function getShipSpend(
  token: string,
  shipId: string,
  from?: string,
  to?: string,
  filter?: SpendFilter,
): Promise<OverviewTokens | null> {
  const query = new URLSearchParams();
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  if (filter?.model) query.set("model", filter.model);
  if (filter?.purpose) query.set("purpose", filter.purpose);
  if (filter?.user) query.set("user", filter.user);
  const suffix = query.toString() ? `?${query}` : "";
  const r = await fetchWithAuth(`ships/${shipId}/overview/spend${suffix}`, {
    token,
  });
  await ok(r, "Load spend");
  return r.json();
}

/** Vessel photo. Multipart, admin-only on the server. */
export async function uploadShipPhoto(
  token: string,
  shipId: string,
  file: File,
): Promise<void> {
  const body = new FormData();
  body.append("file", file);
  const r = await fetchWithAuth(`ships/${shipId}/photo`, {
    token,
    method: "POST",
    body,
  });
  await ok(r, "Upload photo");
}

export async function deleteShipPhoto(
  token: string,
  shipId: string,
): Promise<void> {
  const r = await fetchWithAuth(`ships/${shipId}/photo`, {
    token,
    method: "DELETE",
  });
  await ok(r, "Remove photo");
}

/**
 * The photo bytes. Fetched with the bearer token and handed back as an object
 * URL — the endpoint is not public, so an <img src> pointing straight at it
 * would 401.
 */
export async function fetchShipPhotoUrl(
  token: string,
  shipId: string,
): Promise<string | null> {
  const r = await fetchWithAuth(`ships/${shipId}/photo`, { token });
  if (!r.ok) return null;
  return URL.createObjectURL(await r.blob());
}
