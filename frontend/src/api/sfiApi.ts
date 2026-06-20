import { fetchWithAuth } from "./core";

/** A node in the SFI taxonomy (group, sub-group, or deeper). */
export interface SfiNode {
  id: string;
  code: string;
  name: string;
  level: number;
  groupCode: string;
  parentCode: string | null;
  defaultZone: string | null;
  sortOrder: number;
}

/** Top-level SFI groups (level 1). */
export async function fetchSfiGroups(token: string): Promise<SfiNode[]> {
  const r = await fetchWithAuth(`sfi/groups`, { token });
  if (!r.ok) throw new Error(`Failed to load SFI groups (${r.status})`);
  return (await r.json()) as SfiNode[];
}

/** Sub-groups of a group (level 2 by default — the register's sfi_sub depth). */
export async function fetchSfiSubs(
  token: string,
  groupCode: string,
): Promise<SfiNode[]> {
  const r = await fetchWithAuth(
    `sfi/groups/${encodeURIComponent(groupCode)}/subs`,
    { token },
  );
  if (!r.ok) throw new Error(`Failed to load SFI sub-groups (${r.status})`);
  return (await r.json()) as SfiNode[];
}

/** The whole taxonomy (all levels). Used to label group tabs + sub-groups. */
export async function fetchSfiTaxonomy(token: string): Promise<SfiNode[]> {
  const r = await fetchWithAuth(`sfi/taxonomy`, { token });
  if (!r.ok) throw new Error(`Failed to load SFI taxonomy (${r.status})`);
  return (await r.json()) as SfiNode[];
}
