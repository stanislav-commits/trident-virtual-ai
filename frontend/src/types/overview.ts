// Client-side mirror of the backend overview contract
// (backend/src/modules/overview/overview.types.ts) — the two are kept separate
// on purpose, like types/chat.ts.
//
// The cards deliberately carry `notes` and `degraded`: an Overview that shows a
// confident wrong number is worse than one that admits a gap, so the UI has to
// render the caveats and the "could not compute" state rather than a bare 0.

export type OverviewStatTone = "neutral" | "warn" | "bad" | "good";

export interface OverviewStat {
  label: string;
  value: number;
  tone: OverviewStatTone;
  /** Shown on hover — says what the number does NOT include. */
  hint?: string;
}

export interface OverviewCardDegraded {
  reason: string;
  affects: string[];
}

export interface OverviewCard {
  /** Stable id, e.g. "assets". */
  key: string;
  title: string;
  /** The one big number; null when the area has no data at all. */
  headline: number | null;
  headlineLabel: string;
  stats: OverviewStat[];
  /** Caveats an admin must read to trust the tile. */
  notes: string[];
  /** Admin section id to jump to, e.g. "assets". */
  section: string | null;
  /** Present when a number could not be computed. */
  degraded?: OverviewCardDegraded;
}

export interface OverviewVessel {
  name: string;
  imoNumber: string | null;
  flag: string | null;
  classSociety: string | null;
  buildYear: number | null;
  /** Already a number here — the server converts the numeric column. */
  lengthM: number | null;
  grossTonnage: number | null;
  homePort: string | null;
  callSign: string | null;
  mmsi: string | null;
  shipyard: string | null;
  operationType: string | null;
  fleetManagerEmail: string | null;
  hasPhoto: boolean;
  /** True for the pseudo-ship that holds platform-wide data. */
  isPlatform: boolean;
}

export interface ShipOverviewResponse {
  shipId: string;
  generatedAt: string;
  vessel: OverviewVessel;
  /** Ordered: assets, compliance, maintenance, tasks, crew, inventory, alerts, knowledge, metrics. */
  cards: OverviewCard[];
  /** Phase 2 fills this; the field exists so the UI can render "not tracked yet". */
  tokens: OverviewTokens | null;
}

/**
 * Model spend for the vessel, month to date. `null` while nothing has ever been
 * recorded — that is a different statement from "spent nothing", and the tile
 * says so rather than rendering a zero.
 */
export interface OverviewTokensBucket {
  bucket: "crew" | "platform" | "unattributed";
  tokens: number;
  costUsd: number | null;
}

export interface OverviewTokensModel {
  model: string;
  tokens: number;
  costUsd: number | null;
}

export interface OverviewTokensPurpose {
  purpose: string;
  bucket: "crew" | "platform" | "unattributed";
  calls: number;
  tokens: number;
  costUsd: number | null;
}

export interface OverviewTokensUser {
  /** Null groups every call no person initiated — cron, webhooks, imports. */
  userId: string | null;
  name: string | null;
  login: string | null;
  calls: number;
  tokens: number;
  costUsd: number | null;
}

export interface OverviewTokensDay {
  /** UTC calendar day. */
  day: string;
  tokens: number;
  costUsd: number | null;
}

export interface OverviewTokens {
  rangeStart: string;
  rangeEnd: string;
  recordingStartedAt: string | null;
  calls: number;
  totalTokens: number;
  costUsd: number | null;
  /** The same traffic with caching off — the gap is what caching saved. */
  costWithoutCacheUsd: number | null;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Calls on a model missing from the price book: counted, not costed. */
  unpricedCalls: number;
  byBucket: OverviewTokensBucket[];
  byModel: OverviewTokensModel[];
  byPurpose: OverviewTokensPurpose[];
  byUser: OverviewTokensUser[];
  byDay: OverviewTokensDay[];
}
