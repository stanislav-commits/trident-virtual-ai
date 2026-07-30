import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LlmUsageEntity } from './entities/llm-usage.entity';
import type { LlmUsagePurpose } from './llm-usage.context';

/**
 * What a vessel has spent on models this month.
 *
 * Two groupings, because they answer different questions. `byBucket` separates
 * what the crew consumed from what the platform spent on their data — the split
 * a client will ask about first. `byModel` is the reconciliation view: the
 * provider bills per model, so this is the column that can be checked against
 * their invoice.
 */
export interface UsageBucketTotal {
  bucket: 'crew' | 'platform' | 'unattributed';
  tokens: number;
  costUsd: number | null;
}

export interface UsageModelTotal {
  model: string;
  tokens: number;
  costUsd: number | null;
}

export interface UsagePurposeTotal {
  purpose: LlmUsagePurpose;
  bucket: UsageBucketTotal['bucket'];
  calls: number;
  tokens: number;
  costUsd: number | null;
}

export interface UsageUserTotal {
  /** Null is not one person: it is every call no user initiated (cron, webhooks). */
  userId: string | null;
  name: string | null;
  login: string | null;
  calls: number;
  tokens: number;
  costUsd: number | null;
}

export interface UsageDayTotal {
  /** UTC calendar day, matching `rangeStart`. */
  day: string;
  tokens: number;
  costUsd: number | null;
}

/**
 * Narrows the whole report to one row of one breakdown. Passing a filter does not
 * hide the other breakdowns — it re-cuts them, so filtering by model answers
 * "who used this model, on which days", not just "how much".
 */
export interface UsageFilter {
  model?: string;
  purpose?: string;
  /** A user id, or 'none' for the calls no person initiated. */
  user?: string;
}

export interface ShipUsageMonth {
  /** Inclusive start of the reported window (UTC). */
  rangeStart: string;
  /** Exclusive end. Present so a custom range can state what it covered. */
  rangeEnd: string;
  /** When recording began at all — before this there is no data, not zero spend. */
  recordingStartedAt: string | null;
  calls: number;
  totalTokens: number;
  costUsd: number | null;
  /**
   * What the same traffic would have cost with prompt caching switched off:
   * every cached and cache-written token billed as ordinary input. The gap
   * between this and `costUsd` is what caching is worth on this vessel, which is
   * the number that justifies the whole mechanism on an invoice.
   */
  costWithoutCacheUsd: number | null;
  /** Cached-token counts, so the saving above can be traced to its source. */
  cacheWriteTokens: number;
  cacheReadTokens: number;
  /** Calls whose model is missing from the price book: counted, not costed. */
  unpricedCalls: number;
  byBucket: UsageBucketTotal[];
  byModel: UsageModelTotal[];
  byPurpose: UsagePurposeTotal[];
  byUser: UsageUserTotal[];
  byDay: UsageDayTotal[];
}

/** Everything the crew asked for, versus everything we spent on their data. */
const CREW_PURPOSES: LlmUsagePurpose[] = [
  'chat_answer',
  'chat_classify',
  'chat_decompose',
  'chat_title',
  'chat_summary',
  'chat_vision',
  'chat_write_confirm',
];

/**
 * The counterfactual bill: uncached input, cache writes and cache reads all
 * priced as plain input. Uses the price snapshot stored on the row, so it stays
 * honest after the price book changes.
 */
const NO_CACHE_COST_SUM = `
  SUM(
    CASE WHEN u.priced THEN
      (u.input_tokens + u.cache_write_5m_tokens + u.cache_write_1h_tokens
        + u.cache_read_tokens) * u.price_input_per_mtok / 1000000
      + u.output_tokens * u.price_output_per_mtok / 1000000
    END
  )
`;

const TOKEN_SUM = `
  COALESCE(SUM(
    u.input_tokens + u.output_tokens +
    u.cache_write_5m_tokens + u.cache_write_1h_tokens + u.cache_read_tokens
  ), 0)::bigint
`;

@Injectable()
export class LlmUsageQueryService {
  constructor(
    @InjectRepository(LlmUsageEntity)
    private readonly repository: Repository<LlmUsageEntity>,
  ) {}

  /** Month to date — the page's default window. */
  async monthToDate(shipId: string): Promise<ShipUsageMonth | null> {
    const from = new Date();
    from.setUTCDate(1);
    from.setUTCHours(0, 0, 0, 0);
    return this.range(shipId, from, null);
  }

  /**
   * Spend over an arbitrary window. `to` is exclusive and defaults to now, so a
   * caller asking for "1–31 July" passes 1 Aug and gets all of the 31st.
   */
  async range(
    shipId: string,
    from: Date,
    to: Date | null,
    filter: UsageFilter = {},
  ): Promise<ShipUsageMonth | null> {
    const started = await this.repository
      .createQueryBuilder('u')
      .select('MIN(u.occurred_at)', 'first')
      .getRawOne<{ first: Date | null }>();

    // No row anywhere means the recorder has not run yet. That is different from
    // a vessel that has simply spent nothing, and the page says so.
    if (!started?.first) return null;

    const rangeEnd = to ?? new Date();
    const base = () => {
      const qb = this.repository
        .createQueryBuilder('u')
        .where('u.ship_id = :shipId', { shipId })
        .andWhere('u.occurred_at >= :from', { from })
        .andWhere('u.occurred_at < :to', { to: rangeEnd });
      if (filter.model) {
        qb.andWhere('u.model = :model', { model: filter.model });
      }
      if (filter.purpose) {
        qb.andWhere('u.purpose = :purpose', { purpose: filter.purpose });
      }
      if (filter.user === 'none') {
        qb.andWhere('u.user_id IS NULL');
      } else if (filter.user) {
        qb.andWhere('u.user_id = :userId', { userId: filter.user });
      }
      return qb;
    };

    const totals = await base()
      .select('COUNT(*)::int', 'calls')
      .addSelect(TOKEN_SUM, 'tokens')
      .addSelect('SUM(u.cost_usd)', 'cost')
      .addSelect(NO_CACHE_COST_SUM, 'no_cache_cost')
      .addSelect(
        'COALESCE(SUM(u.cache_write_5m_tokens + u.cache_write_1h_tokens), 0)::bigint',
        'cache_write',
      )
      .addSelect('COALESCE(SUM(u.cache_read_tokens), 0)::bigint', 'cache_read')
      .addSelect('COUNT(*) FILTER (WHERE NOT u.priced)::int', 'unpriced')
      .getRawOne<{
        calls: number;
        tokens: string;
        cost: string | null;
        no_cache_cost: string | null;
        cache_write: string;
        cache_read: string;
        unpriced: number;
      }>();

    const perPurpose = await base()
      .select('u.purpose', 'purpose')
      .addSelect('COUNT(*)::int', 'calls')
      .addSelect(TOKEN_SUM, 'tokens')
      .addSelect('SUM(u.cost_usd)', 'cost')
      .groupBy('u.purpose')
      .orderBy(TOKEN_SUM, 'DESC')
      .getRawMany<{
        purpose: LlmUsagePurpose;
        calls: number;
        tokens: string;
        cost: string | null;
      }>();

    // Left join, not inner: a deleted user must not delete their spend from the
    // statement, and cron work has no user at all.
    const perUser = await base()
      .leftJoin('users', 'usr', 'usr.id = u.user_id')
      .select('u.user_id', 'user_id')
      .addSelect('MAX(usr.name)', 'name')
      .addSelect('MAX(usr.user_id)', 'login')
      .addSelect('COUNT(*)::int', 'calls')
      .addSelect(TOKEN_SUM, 'tokens')
      .addSelect('SUM(u.cost_usd)', 'cost')
      .groupBy('u.user_id')
      .orderBy(TOKEN_SUM, 'DESC')
      .getRawMany<{
        user_id: string | null;
        name: string | null;
        login: string | null;
        calls: number;
        tokens: string;
        cost: string | null;
      }>();

    const perDay = await base()
      .select("to_char(u.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')", 'day')
      .addSelect(TOKEN_SUM, 'tokens')
      .addSelect('SUM(u.cost_usd)', 'cost')
      .groupBy('day')
      .orderBy('day', 'ASC')
      .getRawMany<{ day: string; tokens: string; cost: string | null }>();

    const perModel = await base()
      .select('u.model', 'model')
      .addSelect(TOKEN_SUM, 'tokens')
      .addSelect('SUM(u.cost_usd)', 'cost')
      .groupBy('u.model')
      .orderBy('SUM(u.cost_usd)', 'DESC', 'NULLS LAST')
      .getRawMany<{ model: string; tokens: string; cost: string | null }>();

    const buckets = new Map<UsageBucketTotal['bucket'], UsageBucketTotal>();
    for (const row of perPurpose) {
      const bucket = bucketOf(row.purpose);
      const current = buckets.get(bucket) ?? { bucket, tokens: 0, costUsd: null };
      current.tokens += Number(row.tokens ?? 0);
      if (row.cost != null) {
        current.costUsd = (current.costUsd ?? 0) + Number(row.cost);
      }
      buckets.set(bucket, current);
    }

    return {
      rangeStart: from.toISOString(),
      rangeEnd: rangeEnd.toISOString(),
      recordingStartedAt: new Date(started.first).toISOString(),
      calls: totals?.calls ?? 0,
      totalTokens: Number(totals?.tokens ?? 0),
      costUsd: totals?.cost == null ? null : Number(totals.cost),
      costWithoutCacheUsd:
        totals?.no_cache_cost == null ? null : Number(totals.no_cache_cost),
      cacheWriteTokens: Number(totals?.cache_write ?? 0),
      cacheReadTokens: Number(totals?.cache_read ?? 0),
      unpricedCalls: totals?.unpriced ?? 0,
      byBucket: [...buckets.values()].sort((a, b) => b.tokens - a.tokens),
      byModel: perModel.map((row) => ({
        model: row.model,
        tokens: Number(row.tokens ?? 0),
        costUsd: row.cost == null ? null : Number(row.cost),
      })),
      byPurpose: perPurpose.map((row) => ({
        purpose: row.purpose,
        bucket: bucketOf(row.purpose),
        calls: row.calls ?? 0,
        tokens: Number(row.tokens ?? 0),
        costUsd: row.cost == null ? null : Number(row.cost),
      })),
      byUser: perUser.map((row) => ({
        userId: row.user_id,
        name: row.name,
        login: row.login,
        calls: row.calls ?? 0,
        tokens: Number(row.tokens ?? 0),
        costUsd: row.cost == null ? null : Number(row.cost),
      })),
      byDay: perDay.map((row) => ({
        day: row.day,
        tokens: Number(row.tokens ?? 0),
        costUsd: row.cost == null ? null : Number(row.cost),
      })),
    };
  }
}

/**
 * One place decides which side of the statement a purpose falls on, so the
 * headline split and the per-purpose lines can never disagree about it.
 */
function bucketOf(purpose: LlmUsagePurpose): UsageBucketTotal['bucket'] {
  if (purpose === 'unattributed') return 'unattributed';
  return CREW_PURPOSES.includes(purpose) ? 'crew' : 'platform';
}
