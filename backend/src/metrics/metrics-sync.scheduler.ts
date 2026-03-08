import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MetricsService } from './metrics.service';

@Injectable()
export class MetricsSyncScheduler {
  private readonly logger = new Logger(MetricsSyncScheduler.name);
  private isSyncRunning = false;

  constructor(private readonly metricsService: MetricsService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleMetricsSync() {
    const enabled = process.env.METRICS_SYNC_ENABLED !== 'false';
    if (!enabled) return;

    if (this.isSyncRunning) {
      this.logger.warn(
        'Skipping metrics sync: previous run is still in progress',
      );
      return;
    }

    this.isSyncRunning = true;
    try {
      const result = await this.metricsService.syncFromInflux();
      this.logger.log(
        `Metrics sync finished: definitions=${result.metricsSynced}, values=${result.valuesUpdated}, buckets=${result.buckets.join(',')}`,
      );
    } catch (error) {
      this.logger.error(
        'Metrics sync failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isSyncRunning = false;
    }
  }
}
