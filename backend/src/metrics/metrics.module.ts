import { Module } from '@nestjs/common';
import { GrafanaLlmModule } from '../grafana-llm/grafana-llm.module';
import { InfluxdbModule } from '../influxdb/influxdb.module';
import { TagsModule } from '../tags/tags.module';
import { MetricDescriptionService } from './metric-description.service';
import { MetricsSyncScheduler } from './metrics-sync.scheduler';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [InfluxdbModule, GrafanaLlmModule, TagsModule],
  controllers: [MetricsController],
  providers: [MetricsService, MetricDescriptionService, MetricsSyncScheduler],
  exports: [MetricsService],
})
export class MetricsModule {}
