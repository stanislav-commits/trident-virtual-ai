/**
 * Controlled vocabularies for v14.6 location schema. Source: SFI Master
 * v14.6 `Area_Codes_Reference` sheet — these are the universal codes used
 * across every vessel in the fleet, so chat queries like "zone = M" or
 * "deck_role = BRG" work identically for SeaWolfX, Charade, etc.
 *
 * Validation happens at import / DTO layer — the database column itself
 * is just a short varchar (cheap), no DB-side CHECK constraint, because
 * we may want to extend the vocab without a migration cycle and bad
 * values are caught upstream.
 */

export const ZONE_CODES = [
  'H', // Hull & Structure
  'T', // Tanks
  'M', // Machinery & Technical
  'C', // Crew Accommodation
  'G', // Guest Accommodation
  'O', // Owner Accommodation
  'K', // Galley, Pantries & Bars
  'X', // Circulation
  'S', // Storage & Service
  'W', // Wellness & Spa
  'E', // Entertainment & AV
  'D', // Exterior Decks
  'A', // Aviation & Helideck
  'B', // Beach Club
  'Z', // Other / Specialist (fallback)
] as const;
export type ZoneCode = (typeof ZONE_CODES)[number];

export const ZONE_LABELS: Record<ZoneCode, string> = {
  H: 'Hull & Structure',
  T: 'Tanks',
  M: 'Machinery & Technical',
  C: 'Crew Accommodation',
  G: 'Guest Accommodation',
  O: 'Owner Accommodation',
  K: 'Galley, Pantries & Bars',
  X: 'Circulation',
  S: 'Storage & Service',
  W: 'Wellness & Spa',
  E: 'Entertainment & AV',
  D: 'Exterior Decks',
  A: 'Aviation & Helideck',
  B: 'Beach Club',
  Z: 'Other / Specialist',
};

export const DECK_ROLE_CODES = [
  // Hull
  'HULL-UW',  // Hull — Underwater
  'HULL-AW',  // Hull — Above Waterline
  'HULL-INT', // Hull — Internal Structure
  'OVB',      // Overboard / External Fitting

  // Internal decks (bottom → top)
  'TT',   // Tank Top
  'BOT',  // Bottom Deck
  'LOW',  // Lower Deck
  'LOW2', // Lower Deck 2
  'MAIN', // Main Deck
  'UPP',  // Upper Deck
  'UPP2', // Upper Deck 2
  'BRG',  // Bridge Deck
  'SKY',  // Sky Deck

  // Exterior
  'SUN',  // Sun Deck
  'RAD',  // Radar Arch / Mast
  'EXT',  // Extension / Owner Private
] as const;
export type DeckRoleCode = (typeof DECK_ROLE_CODES)[number];

const ZONE_SET: Set<string> = new Set(ZONE_CODES);
const DECK_ROLE_SET: Set<string> = new Set(DECK_ROLE_CODES);

/** Returns `true` if `code` is one of the 15 universal zone codes. */
export function isValidZoneCode(code: string | null | undefined): code is ZoneCode {
  return typeof code === 'string' && ZONE_SET.has(code);
}

/** Returns `true` if `code` is one of the 16 universal deck-role codes. */
export function isValidDeckRoleCode(
  code: string | null | undefined,
): code is DeckRoleCode {
  return typeof code === 'string' && DECK_ROLE_SET.has(code);
}

/**
 * Compose the v14.6 `asset_full_locator` string used in logs / chat
 * answers. Format: `{assetIdInternal} @ {zone}.{deckRole}.{spaceInstance}`.
 * Missing parts are dropped (no double dots) — keeps the value readable
 * for assets with partial location data.
 */
export function buildAssetFullLocator(parts: {
  assetIdInternal: string;
  zone: string | null;
  deckRole: string | null;
  spaceInstance: string | null;
}): string {
  const tail = [parts.zone, parts.deckRole, parts.spaceInstance]
    .filter((x): x is string => Boolean(x && x.trim()))
    .join('.');
  return tail ? `${parts.assetIdInternal} @ ${tail}` : parts.assetIdInternal;
}
