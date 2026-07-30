/**
 * Contract for the admin Overview section: one page per vessel summarising the
 * state of that vessel's data.
 *
 * Every card carries `notes` and an optional `degraded` because an Overview that
 * shows a confident wrong number is worse than one that admits a gap. An admin
 * uses these tiles to decide where to spend the next hour; a count that silently
 * excludes a whole class of rows (doc types with no document, tasks with neither
 * a due date nor due hours, alerts that were never retained) sends them to the
 * wrong place and quietly burns their trust in the whole page. So a caveat that
 * would change how the number is read goes in `notes`, and an aggregate that
 * could not be computed at all reports `degraded` with `headline: null` rather
 * than falling back to 0 — which is indistinguishable from "nothing is wrong".
 */

export type OverviewStatTone = 'neutral' | 'warn' | 'bad' | 'good';

export type OverviewStat = {
  label: string;
  value: number;
  tone: OverviewStatTone;
  /** Shown on hover — say what the number does NOT include. */
  hint?: string;
};

export type OverviewCardDegraded = {
  reason: string;
  affects: string[];
};

export type OverviewCard = {
  /** Stable id, e.g. 'assets'. */
  key: string;
  title: string;
  /** The one big number; null when the area has no data at all. */
  headline: number | null;
  headlineLabel: string;
  stats: OverviewStat[];
  /** Caveats an admin must read to trust the tile. */
  notes: string[];
  /** Admin section id to jump to, e.g. 'assets'. */
  section: string | null;
  /** Set when a number could not be computed. */
  degraded?: OverviewCardDegraded;
};

export type OverviewVessel = {
  name: string;
  imoNumber: string | null;
  flag: string | null;
  classSociety: string | null;
  buildYear: number | null;
  /** ships.length_m is numeric and TypeORM returns a STRING — convert. */
  lengthM: number | null;
  grossTonnage: number | null;
  homePort: string | null;
  /**
   * Identity an operator actually uses to find the vessel, and who answers for
   * it. Held in the ships table already but shown nowhere, which is how a
   * missing MMSI survives for months.
   */
  callSign: string | null;
  mmsi: string | null;
  shipyard: string | null;
  operationType: string | null;
  fleetManagerEmail: string | null;
  /** Whether a photo has been uploaded — the tile fetches it with the token. */
  hasPhoto: boolean;
  /** The pseudo-ship 00000000-0000-4000-8000-000000000001. */
  isPlatform: boolean;
};

export type ShipOverviewResponse = {
  shipId: string;
  generatedAt: string;
  vessel: OverviewVessel;
  /** Ordered: assets, compliance, maintenance, tasks, crew, inventory, alerts, knowledge, metrics. */
  cards: OverviewCard[];
  /** Phase 2 fills this; the field exists so the UI can render "not tracked yet". */
  tokens: OverviewTokens | null;
};

/**
 * Model spend for the vessel, month to date. `null` while nothing has ever been
 * recorded — that is a different statement from "spent nothing", and the tile
 * says so rather than rendering a zero.
 */
export type OverviewTokensBucket = {
  bucket: 'crew' | 'platform' | 'unattributed';
  tokens: number;
  costUsd: number | null;
};

export type OverviewTokensModel = {
  model: string;
  tokens: number;
  costUsd: number | null;
};

export type OverviewTokensPurpose = {
  purpose: string;
  bucket: 'crew' | 'platform' | 'unattributed';
  calls: number;
  tokens: number;
  costUsd: number | null;
};

export type OverviewTokensUser = {
  /** Null groups every call no person initiated — cron, webhooks, imports. */
  userId: string | null;
  name: string | null;
  login: string | null;
  calls: number;
  tokens: number;
  costUsd: number | null;
};

export type OverviewTokensDay = {
  /** UTC calendar day. */
  day: string;
  tokens: number;
  costUsd: number | null;
};

export type OverviewTokens = {
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
};
