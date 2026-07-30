import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { formatError } from '../../common/utils/error.utils';
import { LlmModelPriceEntity } from './entities/llm-model-price.entity';
import {
  findModelPrices,
  matchPrefix,
  pricesFrom,
  type ModelPrices,
  type TokenCounts,
} from './llm-price-book';

export interface ModelPriceRow {
  modelPrefix: string;
  inputPerMTok: number;
  outputPerMTok: number;
  note: string | null;
  updatedAt: string;
}

/**
 * Prices, read from the table and kept in memory.
 *
 * The recorder asks for a price on every model call, so this cannot be a query
 * per call. The table is small and changes by hand a few times a year, so the
 * whole thing is held in memory and reloaded when it is edited — plus a slow
 * TTL, which is what makes a second process pick up an edit made against the
 * first.
 *
 * If the table cannot be read at all, pricing falls back to the compiled seed
 * book rather than leaving every call unpriced: a stale price is a smaller lie
 * than a report that says the vessel spent nothing.
 */
@Injectable()
export class LlmPriceBookService {
  private readonly logger = new Logger(LlmPriceBookService.name);
  private static readonly TTL_MS = 60_000;

  private book: Array<[string, ModelPrices]> = [];
  private loadedAt = 0;
  private loading: Promise<void> | null = null;

  constructor(
    @InjectRepository(LlmModelPriceEntity)
    private readonly repository: Repository<LlmModelPriceEntity>,
  ) {}

  /**
   * Synchronous on purpose: the recorder is on the path of every model call and
   * must not wait on a database read. A cold or stale cache prices this call
   * from the seed book and refreshes in the background for the next one.
   */
  pricesFor(model: string): ModelPrices | null {
    this.refreshIfStale();
    if (!this.book.length) return findModelPrices(model);
    return matchPrefix(model, this.book);
  }

  costUsd(model: string, tokens: TokenCounts): number | null {
    const p = this.pricesFor(model);
    if (!p) return null;
    return (
      (tokens.inputTokens * p.inputPerMTok +
        tokens.outputTokens * p.outputPerMTok +
        tokens.cacheWrite5mTokens * p.cacheWrite5mPerMTok +
        tokens.cacheWrite1hTokens * p.cacheWrite1hPerMTok +
        tokens.cacheReadTokens * p.cacheReadPerMTok) /
      1_000_000
    );
  }

  async list(): Promise<ModelPriceRow[]> {
    const rows = await this.repository.find({ order: { modelPrefix: 'ASC' } });
    return rows.map((row) => ({
      modelPrefix: row.modelPrefix,
      inputPerMTok: Number(row.inputPerMTok),
      outputPerMTok: Number(row.outputPerMTok),
      note: row.note,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  /** Add or re-rate a model. The prefix identifies the row. */
  async upsert(
    input: {
      modelPrefix: string;
      inputPerMTok: number;
      outputPerMTok: number;
      note?: string | null;
    },
    userId: string | null,
  ): Promise<ModelPriceRow[]> {
    const prefix = input.modelPrefix.trim().toLowerCase();
    if (!prefix) throw new BadRequestException('A model prefix is required.');
    if (prefix.length > 64) {
      throw new BadRequestException('The model prefix is too long.');
    }
    const rate = (value: number, field: string): string => {
      if (!Number.isFinite(value) || value < 0) {
        throw new BadRequestException(`${field} must be a positive number.`);
      }
      // numeric(10,4) — a rate this side of 999999 covers any published price
      // and stops a typo from becoming an unbillable row.
      if (value > 999_999) {
        throw new BadRequestException(`${field} is implausibly large.`);
      }
      return value.toFixed(4);
    };

    const existing = await this.repository.findOne({
      where: { modelPrefix: prefix },
    });
    await this.repository.save({
      ...(existing ?? {}),
      modelPrefix: prefix,
      inputPerMTok: rate(input.inputPerMTok, 'The input rate'),
      outputPerMTok: rate(input.outputPerMTok, 'The output rate'),
      note: input.note?.trim()?.slice(0, 200) || null,
      updatedByUserId: userId,
    });
    await this.reload();
    return this.list();
  }

  async remove(modelPrefix: string): Promise<ModelPriceRow[]> {
    await this.repository.delete({
      modelPrefix: modelPrefix.trim().toLowerCase(),
    });
    await this.reload();
    return this.list();
  }

  private refreshIfStale(): void {
    if (Date.now() - this.loadedAt < LlmPriceBookService.TTL_MS) return;
    if (this.loading) return;
    this.loading = this.reload().finally(() => {
      this.loading = null;
    });
  }

  private async reload(): Promise<void> {
    try {
      const rows = await this.repository.find();
      this.book = rows.map((row) => [
        row.modelPrefix,
        pricesFrom(Number(row.inputPerMTok), Number(row.outputPerMTok)),
      ]);
      this.loadedAt = Date.now();
    } catch (error) {
      // Keep whatever is already cached and try again on the next call; the
      // seed book covers a cold start.
      this.logger.warn(`Could not read the price book: ${formatError(error)}`);
    }
  }
}
