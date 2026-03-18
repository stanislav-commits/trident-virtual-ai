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
        'Skipping values sync: previous sync is still in progress',
      );
      return;
    }

    this.isSyncRunning = true;
    try {
      const result = await this.metricsService.syncValuesFromInflux();
      this.logger.log(
        `Metrics value sync finished: ships=${result.shipsSynced}, organizations=${result.organizations.join(',')}, metricsQueried=${result.metricsQueried}, values=${result.valuesUpdated}, buckets=${result.buckets.join(',')}`,
      );
    } catch (error) {
      this.logger.error(
        'Metrics value sync failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isSyncRunning = false;
    }
  }

  @Cron('0 0 3 * * *')
  async handleCatalogRescan() {
    const enabled = process.env.METRICS_SYNC_ENABLED !== 'false';
    if (!enabled) return;

    if (this.isSyncRunning) {
      this.logger.warn(
        'Skipping catalog rescan: previous sync is still in progress',
      );
      return;
    }

    this.isSyncRunning = true;
    try {
      const result = await this.metricsService.syncCatalogFromInflux();
      this.logger.log(
        `Metrics catalog rescan finished: ships=${result.shipsSynced}, organizations=${result.organizations.join(',')}, definitions=${result.metricsSynced}, pendingDescriptions=${result.pendingDescriptions}, buckets=${result.buckets.join(',')}`,
      );
    } catch (error) {
      this.logger.error(
        'Metrics catalog rescan failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.isSyncRunning = false;
    }
  }
}
