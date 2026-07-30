import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { formatError } from '../../common/utils/error.utils';
import { LlmUsageEntity } from './entities/llm-usage.entity';
import { currentLlmUsageContext } from './llm-usage.context';
import { LlmPriceBookService } from './llm-price-book.service';

/** What a transport reports back about one call. */
export interface LlmCallUsage {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Default TTL (5 minutes) cache writes. */
  cacheWrite5mTokens?: number;
  /** Explicit ttl '1h' cache writes — twice the price of a 5-minute one. */
  cacheWrite1hTokens?: number;
  cacheReadTokens?: number;
  /** Audio length for a per-minute model (transcription). */
  audioSeconds?: number;
  requestId?: string | null;
  latencyMs?: number | null;
  status?: 'ok' | 'error';
}

/**
 * Writes the spend ledger. Called from `LlmService`, which is the only place
 * every model call passes through.
 *
 * Recording must never affect the call it describes: a failed insert is logged
 * and dropped, not thrown, and the write is not awaited by the caller. The cost
 * of losing a row is an understated report; the cost of throwing here would be a
 * broken answer for a crew member at sea.
 */
@Injectable()
export class LlmUsageRecorderService {
  private readonly logger = new Logger(LlmUsageRecorderService.name);

  constructor(
    @InjectRepository(LlmUsageEntity)
    private readonly repository: Repository<LlmUsageEntity>,
    private readonly priceBook: LlmPriceBookService,
  ) {}

  record(usage: LlmCallUsage): void {
    void this.write(usage);
  }

  private async write(usage: LlmCallUsage): Promise<void> {
    try {
      const tokens = {
        inputTokens: Math.max(0, Math.trunc(usage.inputTokens ?? 0)),
        outputTokens: Math.max(0, Math.trunc(usage.outputTokens ?? 0)),
        cacheWrite5mTokens: Math.max(
          0,
          Math.trunc(usage.cacheWrite5mTokens ?? 0),
        ),
        cacheWrite1hTokens: Math.max(
          0,
          Math.trunc(usage.cacheWrite1hTokens ?? 0),
        ),
        cacheReadTokens: Math.max(0, Math.trunc(usage.cacheReadTokens ?? 0)),
        audioSeconds: Math.max(0, Math.trunc(usage.audioSeconds ?? 0)),
      };

      // A call that reported nothing at all is not evidence of zero spend, it is
      // a transport that does not surface usage yet. Keep the row so the gap is
      // countable, but leave it obvious.
      const context = currentLlmUsageContext();
      const prices = this.priceBook.pricesFor(usage.model);
      const cost = this.priceBook.costUsd(usage.model, tokens);

      await this.repository.insert({
        occurredAt: new Date(),
        shipId: context.shipId,
        userId: context.userId,
        purpose: context.purpose,
        provider: usage.provider,
        model: usage.model.slice(0, 64),
        status: usage.status ?? 'ok',
        ...tokens,
        priceInputPerMTok: prices ? String(prices.inputPerMTok) : null,
        priceOutputPerMTok: prices ? String(prices.outputPerMTok) : null,
        priceCacheWrite5mPerMTok: prices
          ? String(prices.cacheWrite5mPerMTok)
          : null,
        priceCacheWrite1hPerMTok: prices
          ? String(prices.cacheWrite1hPerMTok)
          : null,
        priceCacheReadPerMTok: prices ? String(prices.cacheReadPerMTok) : null,
        costUsd: cost === null ? null : cost.toFixed(6),
        priced: cost !== null,
        requestId: usage.requestId?.slice(0, 128) ?? null,
        latencyMs: usage.latencyMs ?? null,
      });
    } catch (error) {
      this.logger.warn(`Could not record LLM usage: ${formatError(error)}`);
    }
  }
}
