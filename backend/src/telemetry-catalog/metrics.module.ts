import { Module } from '@nestjs/common';
import { GrafanaLlmModule } from '../grafana-llm/grafana-llm.module';
import { InfluxdbModule } from '../influxdb/influxdb.module';
import { SemanticModule } from '../semantic/semantic.module';
import { MetricDescriptionService } from './metric-description.service';
import { MetricsSyncScheduler } from './metrics-sync.scheduler';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { TelemetryQuerySemanticNormalizerService } from './live-telemetry/telemetry-query-semantic-normalizer.service';
import { MetricsCatalogSyncService } from './sync/metrics-catalog-sync.service';
import { MetricsValuesSyncService } from './sync/metrics-values-sync.service';

@Module({
  imports: [InfluxdbModule, GrafanaLlmModule, SemanticModule],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MetricDescriptionService,
    MetricsCatalogSyncService,
    MetricsValuesSyncService,
    MetricsSyncScheduler,
    TelemetryQuerySemanticNormalizerService,
  ],
  exports: [MetricsService, MetricsCatalogSyncService, MetricsValuesSyncService],
})
export class MetricsModule {}
