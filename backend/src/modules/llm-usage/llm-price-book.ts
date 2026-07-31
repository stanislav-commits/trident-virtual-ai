/**
 * The shape of a price and the cache multipliers that go with it.
 *
 * The rates themselves live in `llm_model_prices`, editable from the admin panel
 * without a deploy; the table below is what that table is SEEDED with, and what
 * pricing falls back to if the table cannot be read. Prices are copied onto
 * every usage row at the moment of the call, so changing one never moves a
 * statement that has already been issued.
 *
 * The cache multipliers are the part that has bitten us before. Anthropic bills
 * a cache WRITE above the input rate and a cache READ far below it, and the
 * multiplier on a write depends on the TTL requested:
 *   5-minute write  = 1.25x input
 *   1-hour write    = 2x input
 *   read            = 0.1x input
 * The existing cost log in the metric analyzer prices every write at 1.25x while
 * the catalog digest prefix is written with ttl '1h', which is why its numbers
 * come out roughly a third low.
 */

export interface ModelPrices {
  /** USD per million uncached input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
  cacheReadPerMTok: number;
  /** Rate per minute of audio, for models that bill on time (transcription). */
  perMinuteUsd: number | null;
}

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;

function prices(
  inputPerMTok: number,
  outputPerMTok: number,
  perMinuteUsd: number | null = null,
): ModelPrices {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheWrite5mPerMTok: inputPerMTok * CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1hPerMTok: inputPerMTok * CACHE_WRITE_1H_MULTIPLIER,
    cacheReadPerMTok: inputPerMTok * CACHE_READ_MULTIPLIER,
    perMinuteUsd,
  };
}

/**
 * Cold-start fallback: what the table is seeded with and what pricing falls back
 * to before the table has been read. Only the models this platform calls — see
 * the migration for what each one does.
 */
export const SEED_PRICE_BOOK: Array<[prefix: string, input: number, output: number]> = [
  ['claude-sonnet-4', 3, 15],
  ['gpt-5-mini', 0.25, 2],
  ['gpt-4.1-mini', 0.15, 0.6],
  ['gpt-4.1-nano', 0.1, 0.4], // chat titles only
  ['gpt-4o', 2.5, 10],
  ['gpt-4o-mini', 0.15, 0.6],
  ['text-embedding-3-small', 0.02, 0],
];

/** Models billed per minute of audio rather than per token. */
export const SEED_PER_MINUTE_PRICES: Array<[prefix: string, perMinute: number]> = [
  ['whisper', 0.006],
];

/**
 * Longest prefix wins, so a dated alias (claude-sonnet-4-6-20251114) matches its
 * family entry. Anything unmatched is left UNPRICED rather than being quietly
 * charged at some default: an unknown model on an invoice must be visible, and
 * the old fallback silently priced Claude-family models at a mini model's rate.
 */
const PRICE_BOOK: Array<[prefix: string, prices: ModelPrices]> = [
  ...SEED_PRICE_BOOK.map(
    ([prefix, input, output]): [string, ModelPrices] => [
      prefix,
      prices(input, output),
    ],
  ),
  ...SEED_PER_MINUTE_PRICES.map(
    ([prefix, perMinute]): [string, ModelPrices] => [
      prefix,
      prices(0, 0, perMinute),
    ],
  ),
];

export function pricesFrom(
  inputPerMTok: number,
  outputPerMTok: number,
  perMinuteUsd: number | null = null,
): ModelPrices {
  return prices(inputPerMTok, outputPerMTok, perMinuteUsd);
}

/** Prefix match over an arbitrary book — the table's, or the seed fallback. */
export function matchPrefix(
  model: string,
  book: Array<[prefix: string, prices: ModelPrices]>,
): ModelPrices | null {
  const key = model.trim().toLowerCase();
  let best: { length: number; prices: ModelPrices } | null = null;
  for (const [prefix, value] of book) {
    if (key.startsWith(prefix) && (!best || prefix.length > best.length)) {
      best = { length: prefix.length, prices: value };
    }
  }
  return best?.prices ?? null;
}

export function findModelPrices(model: string): ModelPrices | null {
  const key = model.trim().toLowerCase();
  let best: { length: number; prices: ModelPrices } | null = null;
  for (const [prefix, value] of PRICE_BOOK) {
    if (key.startsWith(prefix) && (!best || prefix.length > best.length)) {
      best = { length: prefix.length, prices: value };
    }
  }
  return best?.prices ?? null;
}

export interface TokenCounts {
  /** Audio length for a per-minute model; 0 for token-billed calls. */
  audioSeconds?: number;
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
}

/** Cost of one call in USD, or null when the model is not in the book. */
export function computeCostUsd(
  model: string,
  tokens: TokenCounts,
): number | null {
  const p = findModelPrices(model);
  if (!p) return null;
  if (p.perMinuteUsd != null) {
    return ((tokens.audioSeconds ?? 0) / 60) * p.perMinuteUsd;
  }
  const perMillion =
    tokens.inputTokens * p.inputPerMTok +
    tokens.outputTokens * p.outputPerMTok +
    tokens.cacheWrite5mTokens * p.cacheWrite5mPerMTok +
    tokens.cacheWrite1hTokens * p.cacheWrite1hPerMTok +
    tokens.cacheReadTokens * p.cacheReadPerMTok;
  return perMillion / 1_000_000;
}
