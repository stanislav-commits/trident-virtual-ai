/**
 * What a thousand-token slice of each model costs, in USD per million tokens.
 *
 * These are copied onto every usage row at the moment of the call, so this file
 * is a source of prices for NEW rows only — editing it never moves a statement
 * that has already been issued.
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
}

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;

function prices(inputPerMTok: number, outputPerMTok: number): ModelPrices {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheWrite5mPerMTok: inputPerMTok * CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1hPerMTok: inputPerMTok * CACHE_WRITE_1H_MULTIPLIER,
    cacheReadPerMTok: inputPerMTok * CACHE_READ_MULTIPLIER,
  };
}

/**
 * Longest prefix wins, so a dated alias (claude-sonnet-4-6-20251114) matches its
 * family entry. Anything unmatched is left UNPRICED rather than being quietly
 * charged at some default: an unknown model on an invoice must be visible, and
 * the old fallback silently priced Claude-family models at a mini model's rate.
 */
const PRICE_BOOK: Array<[prefix: string, prices: ModelPrices]> = [
  ['claude-opus-4', prices(5, 25)],
  ['claude-opus', prices(5, 25)],
  ['claude-sonnet-4', prices(3, 15)],
  ['claude-sonnet', prices(3, 15)],
  ['claude-haiku', prices(1, 5)],
  ['gpt-5-mini', prices(0.25, 2)],
  ['gpt-5', prices(1.25, 10)],
  ['gpt-4.1-mini', prices(0.15, 0.6)],
  ['gpt-4.1', prices(2, 8)],
  ['gpt-4o-mini', prices(0.15, 0.6)],
  ['gpt-4o', prices(2.5, 10)],
];

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
  const perMillion =
    tokens.inputTokens * p.inputPerMTok +
    tokens.outputTokens * p.outputPerMTok +
    tokens.cacheWrite5mTokens * p.cacheWrite5mPerMTok +
    tokens.cacheWrite1hTokens * p.cacheWrite1hPerMTok +
    tokens.cacheReadTokens * p.cacheReadPerMTok;
  return perMillion / 1_000_000;
}
