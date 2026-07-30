import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { LlmUsagePurpose } from '../llm-usage.context';

/**
 * One row per call to a model provider — the ledger behind "what did this vessel
 * cost in AI this month".
 *
 * Append-only by intent: nothing updates a row after the call it describes, so a
 * statement can be re-derived from the same rows for as long as they are kept.
 * The prices used are copied in (see the migration for why), which also means a
 * row stays meaningful after the price book changes underneath it.
 */
@Entity('llm_usage')
@Index('IDX_llm_usage_ship_time', ['shipId', 'occurredAt'])
@Index('IDX_llm_usage_time', ['occurredAt'])
export class LlmUsageEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'occurred_at', type: 'timestamptz', default: () => 'now()' })
  occurredAt!: Date;

  /** Null for platform work and for anything an admin does — admins have no ship. */
  @Column({ name: 'ship_id', type: 'uuid', nullable: true })
  shipId!: string | null;

  /** Null for scheduled work: a cron job has no actor. */
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', length: 48, default: 'unattributed' })
  purpose!: LlmUsagePurpose;

  @Column({ type: 'varchar', length: 24 })
  provider!: string;

  @Column({ type: 'varchar', length: 64 })
  model!: string;

  /** 'ok' | 'error' — a failed call that produced tokens still cost money. */
  @Column({ type: 'varchar', length: 16, default: 'ok' })
  status!: string;

  /**
   * UNCACHED input only. On Anthropic the three input buckets are disjoint, so
   * the call's real input is this plus both cache-write columns plus cache read.
   */
  @Column({ name: 'input_tokens', type: 'int', default: 0 })
  inputTokens!: number;

  @Column({ name: 'output_tokens', type: 'int', default: 0 })
  outputTokens!: number;

  /** Split by TTL because 5-minute and 1-hour writes bill at 1.25x and 2x. */
  @Column({ name: 'cache_write_5m_tokens', type: 'int', default: 0 })
  cacheWrite5mTokens!: number;

  @Column({ name: 'cache_write_1h_tokens', type: 'int', default: 0 })
  cacheWrite1hTokens!: number;

  @Column({ name: 'cache_read_tokens', type: 'int', default: 0 })
  cacheReadTokens!: number;

  /**
   * Length of the audio a transcription call was billed on. Zero for every
   * token-billed call — the two never mix on one row.
   */
  @Column({ name: 'audio_seconds', type: 'int', default: 0 })
  audioSeconds!: number;

  @Column({
    name: 'price_input_per_mtok',
    type: 'numeric',
    precision: 10,
    scale: 4,
    nullable: true,
  })
  priceInputPerMTok!: string | null;

  @Column({
    name: 'price_output_per_mtok',
    type: 'numeric',
    precision: 10,
    scale: 4,
    nullable: true,
  })
  priceOutputPerMTok!: string | null;

  @Column({
    name: 'price_cache_write_5m_per_mtok',
    type: 'numeric',
    precision: 10,
    scale: 4,
    nullable: true,
  })
  priceCacheWrite5mPerMTok!: string | null;

  @Column({
    name: 'price_cache_write_1h_per_mtok',
    type: 'numeric',
    precision: 10,
    scale: 4,
    nullable: true,
  })
  priceCacheWrite1hPerMTok!: string | null;

  @Column({
    name: 'price_cache_read_per_mtok',
    type: 'numeric',
    precision: 10,
    scale: 4,
    nullable: true,
  })
  priceCacheReadPerMTok!: string | null;

  /** Numeric columns come back as strings from the driver. */
  @Column({
    name: 'cost_usd',
    type: 'numeric',
    precision: 12,
    scale: 6,
    nullable: true,
  })
  costUsd!: string | null;

  /** False when the model was not in the price book — the tokens still count. */
  @Column({ type: 'boolean', default: false })
  priced!: boolean;

  /** The provider's own request id, so a disputed line can be traced. */
  @Column({ name: 'request_id', type: 'varchar', length: 128, nullable: true })
  requestId!: string | null;

  @Column({ name: 'latency_ms', type: 'int', nullable: true })
  latencyMs!: number | null;
}
