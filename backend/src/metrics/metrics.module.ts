import { Module } from '@nestjs/common';
import { GrafanaLlmModule } from '../grafana-llm/grafana-llm.module';
import { InfluxdbModule } from '../influxdb/influxdb.module';
import { SemanticModule } from '../semantic/semantic.module';
import { TagsModule } from '../tags/tags.module';
import { MetricDescriptionService } from './metric-description.service';
import { MetricsSyncScheduler } from './metrics-sync.scheduler';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { TelemetryQuerySemanticNormalizerService } from './live-telemetry/telemetry-query-semantic-normalizer.service';

@Module({
  imports: [InfluxdbModule, GrafanaLlmModule, TagsModule, SemanticModule],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MetricDescriptionService,
    MetricsSyncScheduler,
    TelemetryQuerySemanticNormalizerService,
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
