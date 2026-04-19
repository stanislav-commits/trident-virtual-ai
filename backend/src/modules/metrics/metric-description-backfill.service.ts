import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Like, Repository } from 'typeorm';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { MetricDescriptionService } from './metric-description.service';
import {
  normalizeMetricDescription,
  parseMetricCatalogKey,
  shouldBackfillMetricDescription,
} from './metric-description.utils';

interface DescriptionBackfillBatchResult {
  generated: number;
  cooldownMs: number;
  hasMore: boolean;
}

@Injectable()
export class MetricDescriptionBackfillService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(MetricDescriptionBackfillService.name);
  private isBackfillRunning = false;
  private shouldRerunBackfill = false;
  private resumeTimer: NodeJS.Timeout | null = null;
  private resumeAt = 0;

  constructor(
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly shipMetricCatalogRepository: Repository<ShipMetricCatalogEntity>,
    private readonly metricDescriptionService: MetricDescriptionService,
  ) {}

  onModuleInit() {
    this.scheduleBackfill('startup');
  }

  onModuleDestroy() {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
      this.resumeAt = 0;
    }
  }

  scheduleBackfill(trigger: string) {
    if (!this.metricDescriptionService.isConfigured()) {
      return;
    }

    const cooldownMs = this.metricDescriptionService.getBackfillCooldownMs();

    if (cooldownMs > 0) {
      this.scheduleResume(cooldownMs, trigger);
      return;
    }

    if (this.isBackfillRunning) {
      this.shouldRerunBackfill = true;
      return;
    }

    this.isBackfillRunning = true;
    setTimeout(() => {
      void this.runBackfill(trigger);
    }, 0);
  }

  private async runBackfill(trigger: string): Promise<void> {
    let generated = 0;
    let cooldownMs = 0;

    try {
      do {
        this.shouldRerunBackfill = false;
        const batchResult = await this.generateDescriptionsBatch(100);
        generated += batchResult.generated;
        cooldownMs = batchResult.cooldownMs;
        this.shouldRerunBackfill =
          this.shouldRerunBackfill || batchResult.hasMore;
      } while (this.shouldRerunBackfill && cooldownMs === 0);

      if (generated > 0) {
        this.logger.log(
          `Metric description backfill completed: generated=${generated}, trigger=${trigger}`,
        );
      }
    } catch (error) {
      this.logger.error(
        'Metric description backfill failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isBackfillRunning = false;

      if (cooldownMs > 0) {
        this.scheduleResume(cooldownMs, trigger);
      }

      if (this.shouldRerunBackfill) {
        this.scheduleBackfill('rerun');
      }
    }
  }

  private async generateDescriptionsBatch(
    limit: number,
  ): Promise<DescriptionBackfillBatchResult> {
    if (!this.metricDescriptionService.isConfigured()) {
      return { generated: 0, cooldownMs: 0, hasMore: false };
    }

    const initialCooldownMs = this.metricDescriptionService.getBackfillCooldownMs();

    if (initialCooldownMs > 0) {
      return { generated: 0, cooldownMs: initialCooldownMs, hasMore: true };
    }

    const pendingEntries = await this.shipMetricCatalogRepository.find({
      where: [
        { description: IsNull() },
        { description: '' },
        { description: Like('Displays the current %') },
      ],
      order: {
        syncedAt: 'DESC',
        updatedAt: 'ASC',
      },
      take: limit,
    });

    if (pendingEntries.length === 0) {
      return { generated: 0, cooldownMs: 0, hasMore: false };
    }

    let generated = 0;

    for (const entry of pendingEntries) {
      if (!shouldBackfillMetricDescription(entry.description)) {
        continue;
      }

      const parsedKey = parseMetricCatalogKey(entry.key);
      const measurement = parsedKey.measurement ?? '';
      const description = await this.metricDescriptionService.generateDescription({
        key: entry.key,
        bucket: entry.bucket,
        measurement,
        field: entry.field,
        label: measurement ? `${measurement}.${entry.field}` : entry.field,
      });

      if (!description) {
        const cooldownMs = this.metricDescriptionService.getBackfillCooldownMs();

        if (cooldownMs > 0) {
          return {
            generated,
            cooldownMs,
            hasMore: true,
          };
        }

        continue;
      }

      await this.shipMetricCatalogRepository.update(entry.id, {
        description: normalizeMetricDescription(description),
      });
      generated += 1;
    }

    return {
      generated,
      cooldownMs: 0,
      hasMore: pendingEntries.length === limit,
    };
  }

  private scheduleResume(cooldownMs: number, trigger: string) {
    const resumeAt = Date.now() + cooldownMs;

    if (this.resumeTimer && this.resumeAt >= resumeAt) {
      return;
    }

    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
    }

    this.resumeAt = resumeAt;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.resumeAt = 0;
      this.scheduleBackfill(`${trigger}:cooldown-expired`);
    }, cooldownMs);

    this.logger.warn(
      `Metric description backfill paused for ${Math.ceil(
        cooldownMs / 1000,
      )}s due to Grafana LLM cooldown (trigger=${trigger}).`,
    );
  }
}
