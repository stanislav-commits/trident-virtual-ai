/**
 * SFI group color palette — adopted from the tridentV2 design brief
 * (`styles.css` --sfi-NN custom properties). Each top-level SFI group
 * gets its own "light" used as a colored left-border on the group row
 * + as a colored dot/badge across the asset register UI.
 */

export const SFI_GROUP_COLORS: Record<string, string> = {
  "1":  "#C0C0C0",  // 01 — Ship general / certificates
  "2":  "#4E8FD4",  // 02 — Hull, doors, hatches, tanks
  "3":  "#3AAA62",  // 03 — Engines, propulsion, steering
  "4":  "#D4702A",  // 04 — Machinery & auxiliaries
  "5":  "#A050C8",  // 05 — Electrical power & distribution
  "6":  "#C89830",  // 06 — HVAC & refrigeration
  "7":  "#00B4D8",  // 07 — Water, bilge, tanks
  "8":  "#CC2244",  // 08 — Fire, safety, security
  "9":  "#8888FF",  // 09 — Navigation, comms, bridge
  "10": "#00D4C0",  // 10 — AV, IT, automation
  "11": "#E040A0",  // 11 — Deck equipment, cranes
  "12": "#D4882A",  // 12 — Tenders & toys
  "13": "#FF80C0",  // 13 — Galley & hospitality
  "14": "#7ACC44",  // 14 — Accommodation & interior
  "15": "#E8A87C",  // 15 — Medical & health
  "16": "#5DADE2",  // 16 — Aviation & helideck
  "17": "#A8B8D0",  // 17 — Engineering inventory
  "18": "#A0B0D0",  // 18 — Deck inventory
  "19": "#90A8C8",  // 19 — Interior inventory
  "20": "#80A0C0",  // 20 — Galley inventory
  "21": "#7090B8",  // 21 — Laundry inventory
};

const DEFAULT = "#94A3B8"; // slate-400

/** Returns the hex colour for an SFI group code; falls back to a neutral grey. */
export function sfiColorForGroup(group: string | null | undefined): string {
  if (!group) return DEFAULT;
  // Normalize "3.0" → "3"
  const key = String(group).trim().split(".")[0].replace(/^0/, "");
  return SFI_GROUP_COLORS[key] ?? DEFAULT;
}

/**
 * Friendly display name for each top-level SFI group. The asset register
 * does not require these names to be present — when a Group column is in
 * the imported xlsx, that takes precedence. These are the fallback labels.
 */
export const SFI_GROUP_NAMES: Record<string, string> = {
  "1":  "Ship general",
  "2":  "Hull, doors, hatches",
  "3":  "Engines, propulsion, steering",
  "4":  "Machinery & auxiliaries",
  "5":  "Electrical power & distribution",
  "6":  "HVAC & refrigeration",
  "7":  "Water, bilge, tanks",
  "8":  "Fire, safety, security",
  "9":  "Navigation, comms, bridge",
  "10": "AV, IT, automation",
  "11": "Deck equipment & cranes",
  "12": "Tenders & toys",
  "13": "Galley & hospitality",
  "14": "Accommodation & interior",
  "15": "Medical & health",
  "16": "Aviation & helideck",
  "17": "Engineering inventory",
  "18": "Deck inventory",
  "19": "Interior inventory",
  "20": "Galley inventory",
  "21": "Laundry inventory",
};

export function sfiGroupName(group: string | null | undefined): string {
  if (!group) return "Ungrouped";
  const key = String(group).trim().split(".")[0].replace(/^0/, "");
  return SFI_GROUP_NAMES[key] ?? `Group ${key}`;
}
