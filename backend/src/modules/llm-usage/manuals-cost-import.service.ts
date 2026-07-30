import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Repository } from 'typeorm';
import { formatError } from '../../common/utils/error.utils';
import { LlmUsageEntity } from './entities/llm-usage.entity';
import { LlmPriceBookService } from './llm-price-book.service';

/** How the manual extractor's own audit log names its columns. */
interface CostRow {
  timestamp: string;
  file_id: string;
  stage: string;
  model: string;
  input_tokens: string;
  output_tokens: string;
  images_count: string;
  cost_usd: string;
  from_cache: string;
}

export const MANUALS_PROVIDER = 'openai-manuals';

/**
 * The manual extractor's spend, pulled into the ledger.
 *
 * Extraction runs as a separate Python tool on the droplet with its own OpenAI
 * key, so nothing it spends passes through LlmService — and it is by far the
 * biggest spender on the platform: reading a manual costs more than a month of
 * chat. Leaving it out made the usage card a report on the cheap half of the
 * bill.
 *
 * The tool already writes every call to `05-logs/api-costs.csv` (append-only,
 * one row per call, tokens and stage included), so this reads that file rather
 * than asking the tool to change. Rows are keyed by their own contents and
 * inserted with ON CONFLICT DO NOTHING, which makes a re-run a no-op and lets
 * the whole file be replayed at any time.
 *
 * Cache hits are skipped: the pipeline served them from disk without calling
 * the provider, so they are not spend and counting them would inflate both the
 * call count and the token total.
 */
@Injectable()
export class ManualsCostImportService {
  private readonly logger = new Logger(ManualsCostImportService.name);

  constructor(
    @InjectRepository(LlmUsageEntity)
    private readonly repository: Repository<LlmUsageEntity>,
    private readonly configService: ConfigService,
    private readonly priceBook: LlmPriceBookService,
  ) {}

  /**
   * Never throws: importing the ledger must not fail an extraction run.
   *
   * `shipId` is the vessel whose document was just extracted. The extractor's
   * own log has no vessel in it — it knows files, not fleets — so attribution
   * comes from the caller, which is the only place it is known. A backfill of
   * older rows has no caller and stays unattributed rather than being guessed
   * onto whichever vessel happens to exist.
   */
  async importQuietly(shipId: string | null = null): Promise<void> {
    try {
      const { imported, skipped } = await this.import(shipId);
      if (imported) {
        this.logger.log(
          `Imported ${imported} manual-extractor calls (${skipped} cache hits skipped)`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Could not import manual-extractor costs: ${formatError(error)}`,
      );
    }
  }

  async import(
    shipId: string | null = null,
  ): Promise<{ imported: number; skipped: number }> {
    const dir = this.configService
      .get<string>('integrations.visionExtractor.dir', '')
      .trim();
    if (!dir) return { imported: 0, skipped: 0 };

    const csv = await readFile(join(dir, '05-logs', 'api-costs.csv'), 'utf8');
    const rows = parseCsv(csv);

    // The log is append-only and never rotated, so it only grows — replaying it
    // whole after every extraction would mean re-reading a year of history to
    // record thirty new calls. Start an hour before the newest row already
    // imported; the conflict key still decides what is new, this only bounds
    // how much is offered to it. A full replay (the backfill script) simply
    // finds nothing imported yet and reads everything.
    const latest = await this.repository
      .createQueryBuilder('u')
      .select('MAX(u.occurred_at)', 'last')
      .where('u.provider = :provider', { provider: MANUALS_PROVIDER })
      .getRawOne<{ last: Date | null }>();
    const floor = latest?.last
      ? new Date(latest.last.getTime() - 60 * 60 * 1000)
      : null;

    let imported = 0;
    let skipped = 0;
    const batch: Array<Partial<LlmUsageEntity>> = [];
    for (const row of rows) {
      if ((row.from_cache ?? '').toLowerCase() === 'yes') {
        skipped += 1;
        continue;
      }
      const occurredAt = new Date(row.timestamp);
      if (Number.isNaN(occurredAt.getTime())) continue;
      if (floor && occurredAt < floor) continue;

      const model = (row.model ?? '').trim().slice(0, 64);
      const inputTokens = int(row.input_tokens);
      const outputTokens = int(row.output_tokens);
      const prices = this.priceBook.pricesFor(model);
      const cost = this.priceBook.costUsd(model, {
        inputTokens,
        outputTokens,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
      });

      batch.push({
        occurredAt,
        shipId,
        userId: null,
        // The stage is the extractor's own word for what it was doing
        // (vision_rebuild, classification, alias_generation); the ledger only
        // needs to know this was document ingestion.
        purpose: 'doc_ingest',
        provider: MANUALS_PROVIDER,
        model,
        status: 'ok',
        inputTokens,
        outputTokens,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
        priceInputPerMTok: prices ? String(prices.inputPerMTok) : null,
        priceOutputPerMTok: prices ? String(prices.outputPerMTok) : null,
        priceCacheWrite5mPerMTok: null,
        priceCacheWrite1hPerMTok: null,
        priceCacheReadPerMTok: null,
        costUsd: cost === null ? null : cost.toFixed(6),
        priced: cost !== null,
        requestId: rowKey(row),
        latencyMs: null,
      });
    }

    // Chunked: the first import replays the whole history, which is ten
    // thousand rows and counting.
    for (let i = 0; i < batch.length; i += 500) {
      const result = await this.repository
        .createQueryBuilder()
        .insert()
        .into(LlmUsageEntity)
        .values(batch.slice(i, i + 500))
        .orIgnore()
        .execute();
      imported += result.identifiers.filter(Boolean).length;
    }
    return { imported, skipped };
  }
}

/**
 * The row's own identity, used as the conflict key. Two calls in the same
 * second, on the same file and stage, with the same token counts are the same
 * row replayed — the extractor writes no id of its own.
 */
function rowKey(row: CostRow): string {
  return [
    'manuals',
    row.timestamp,
    row.file_id,
    row.stage,
    row.model,
    row.input_tokens,
    row.output_tokens,
    row.images_count,
  ]
    .join(':')
    .slice(0, 128);
}

function int(value: string | undefined): number {
  const parsed = Number.parseInt((value ?? '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Minimal CSV reader — the file is machine-written, plain and comma-separated. */
function parseCsv(text: string): CostRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (!lines.length) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row: Record<string, string> = {};
    header.forEach((key, i) => {
      row[key] = (cells[i] ?? '').trim();
    });
    return row as unknown as CostRow;
  });
}
