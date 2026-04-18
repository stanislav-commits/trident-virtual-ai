import { Module } from '@nestjs/common';
import { AssistantTextModule } from '../assistant-text/assistant-text.module';
import { InfluxdbModule } from '../influxdb/influxdb.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MetricsV2CatalogService } from './catalog/metrics-v2-catalog.service';
import { MetricsV2MetricResolverService } from './catalog/metrics-v2-metric-resolver.service';
import { MetricsV2ClarificationService } from './execution/metrics-v2-clarification.service';
import { MetricsV2DerivedAnswerService } from './execution/metrics-v2-derived-answer.service';
import { MetricsV2QueryExecutorService } from './execution/metrics-v2-query-executor.service';
import { MetricsV2ReverseGeocoderService } from './execution/metrics-v2-reverse-geocoder.service';
import { MetricsV2CapabilityPlanService } from './planning/metrics-v2-capability-plan.service';
import { MetricsV2QueryPlannerService } from './planning/metrics-v2-query-planner.service';
import { MetricsV2RequestClassifierService } from './planning/metrics-v2-request-classifier.service';
import { MetricsV2CurrentProvider } from './providers/metrics-v2-current.provider';
import { MetricsV2HistoricalProvider } from './providers/metrics-v2-historical.provider';
import { MetricsV2ClarificationContinuationService } from './metrics-v2-clarification-continuation.service';
import { MetricsV2ResponderService } from './metrics-v2-responder.service';
import { MetricsV2ResponseComposerService } from './responders/metrics-v2-response-composer.service';

@Module({
  imports: [PrismaModule, InfluxdbModule, AssistantTextModule],
  providers: [
    MetricsV2ResponderService,
    MetricsV2RequestClassifierService,
    MetricsV2CapabilityPlanService,
    MetricsV2QueryPlannerService,
    MetricsV2CatalogService,
    MetricsV2MetricResolverService,
    MetricsV2ClarificationService,
    MetricsV2DerivedAnswerService,
    MetricsV2ReverseGeocoderService,
    MetricsV2QueryExecutorService,
    MetricsV2CurrentProvider,
    MetricsV2HistoricalProvider,
    MetricsV2ClarificationContinuationService,
    MetricsV2ResponseComposerService,
  ],
  exports: [MetricsV2ResponderService, MetricsV2ClarificationContinuationService],
})
export class MetricsV2Module {}
