import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { ShipEntity } from '../ships/entities/ship.entity';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { MetricDescriptionBackfillService } from './metric-description-backfill.service';
import { MetricDescriptionService } from './metric-description.service';
import { MetricsCatalogService } from './metrics-catalog.service';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

@Module({
  imports: [
    IntegrationsModule,
    TypeOrmModule.forFeature([ShipEntity, ShipMetricCatalogEntity]),
  ],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MetricsCatalogService,
    MetricDescriptionService,
    MetricDescriptionBackfillService,
  ],
  exports: [
    MetricsService,
    MetricsCatalogService,
    MetricDescriptionService,
    MetricDescriptionBackfillService,
  ],
})
export class MetricsModule {}
