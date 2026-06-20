/**
 * SFI group colour palette + names — from the SFI Master (Colour Legend),
 * RENUMBERED -1: the asset register excludes old group 1 (Vessel General /
 * certificates), so groups 2..21 shift to 1..20. Each top-level group gets a
 * colour used as a dot/badge + row tint across the asset register UI. These
 * are fallbacks; when the SFI catalog is loaded the live names take precedence.
 */

export const SFI_GROUP_COLORS: Record<string, string> = {
  "1":  "#4E8FD4",  // Hull & Structure (was 02)
  "2":  "#3AAA62",  // Propulsion & Power Generation (was 03)
  "3":  "#D4702A",  // Machinery Systems (was 04)
  "4":  "#A050C8",  // Electrical Systems (was 05)
  "5":  "#C89830",  // HVAC & Refrigeration (was 06)
  "6":  "#00B4D8",  // Water Systems (was 07)
  "7":  "#CC2244",  // Fire, Safety & Security (was 08)
  "8":  "#8888FF",  // Navigation, Bridge & Comms (was 09)
  "9":  "#00D4C0",  // AV, IT & Automation (was 10)
  "10": "#E040A0",  // Deck Equipment & Lifting (was 11)
  "11": "#D4882A",  // Tenders, Toys & Recreational (was 12)
  "12": "#FF80C0",  // Galley, Laundry & Hospitality (was 13)
  "13": "#7ACC44",  // Accommodation & Interior (was 14)
  "14": "#E8A87C",  // Medical & Health (was 15)
  "15": "#5DADE2",  // Aviation & Helideck (was 16)
  "16": "#A8B8D0",  // Engineering Inventory (was 17)
  "17": "#A0B0D0",  // Deck Inventory (was 18)
  "18": "#90A8C8",  // Interior Inventory (was 19)
  "19": "#80A0C0",  // Galley Inventory (was 20)
  "20": "#7090B0",  // Laundry Inventory (was 21)
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
 * Friendly display name for each top-level SFI group (renumbered -1, master
 * names). Fallback labels — the loaded SFI catalog takes precedence in the UI.
 */
export const SFI_GROUP_NAMES: Record<string, string> = {
  "1":  "Hull & Structure",
  "2":  "Propulsion & Power Generation",
  "3":  "Machinery Systems",
  "4":  "Electrical Systems",
  "5":  "HVAC & Refrigeration",
  "6":  "Water Systems",
  "7":  "Fire, Safety & Security",
  "8":  "Navigation, Bridge & Comms",
  "9":  "AV, IT & Automation",
  "10": "Deck Equipment & Lifting",
  "11": "Tenders, Toys & Recreational Craft",
  "12": "Galley, Laundry & Hospitality",
  "13": "Accommodation & Interior",
  "14": "Medical & Health",
  "15": "Aviation & Helideck",
  "16": "Engineering Inventory",
  "17": "Deck Inventory",
  "18": "Interior Inventory",
  "19": "Galley Inventory",
  "20": "Laundry Inventory",
};

export function sfiGroupName(group: string | null | undefined): string {
  if (!group) return "Ungrouped";
  const key = String(group).trim().split(".")[0].replace(/^0/, "");
  return SFI_GROUP_NAMES[key] ?? `Group ${key}`;
}
