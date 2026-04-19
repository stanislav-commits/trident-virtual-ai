import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { ShipEntity } from '../ships/entities/ship.entity';
import { MetricConceptAliasEntity } from './entities/metric-concept-alias.entity';
import { MetricConceptEntity } from './entities/metric-concept.entity';
import { MetricConceptMemberEntity } from './entities/metric-concept-member.entity';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { MetricDescriptionBackfillService } from './metric-description-backfill.service';
import { MetricDescriptionService } from './metric-description.service';
import { MetricsCatalogService } from './metrics-catalog.service';
import { MetricsConceptExecutionService } from './metrics-concept-execution.service';
import { MetricsSemanticBootstrapService } from './metrics-semantic-bootstrap.service';
import { MetricsController } from './metrics.controller';
import { MetricsSemanticCatalogService } from './metrics-semantic-catalog.service';
import { MetricsService } from './metrics.service';

@Module({
  imports: [
    IntegrationsModule,
    TypeOrmModule.forFeature([
      ShipEntity,
      ShipMetricCatalogEntity,
      MetricConceptEntity,
      MetricConceptAliasEntity,
      MetricConceptMemberEntity,
    ]),
  ],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MetricsCatalogService,
    MetricsConceptExecutionService,
    MetricsSemanticBootstrapService,
    MetricsSemanticCatalogService,
    MetricDescriptionService,
    MetricDescriptionBackfillService,
  ],
  exports: [
    MetricsService,
    MetricsCatalogService,
    MetricsConceptExecutionService,
    MetricsSemanticBootstrapService,
    MetricsSemanticCatalogService,
    MetricDescriptionService,
    MetricDescriptionBackfillService,
  ],
})
export class MetricsModule {}
