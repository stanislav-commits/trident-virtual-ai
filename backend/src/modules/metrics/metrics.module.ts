import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { AssetEntity } from '../assets/entities/asset.entity';
import { ServiceRuleEntity } from '../assets/entities/service-rule.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
// Entities (NOT modules) for the analyzer's cross-domain tools — registering an
// entity in forFeature does not import its owning module, so this avoids the
// Metrics↔Pms↔Crew↔Users↔Ships DI cycle.
import { PmsTaskEntity } from '../pms/entities/pms-task.entity';
import { ComplianceDocEntity } from '../compliance/entities/compliance-doc.entity';
import { ComplianceDocTypeEntity } from '../compliance/entities/compliance-doc-type.entity';
import { InventoryItemEntity } from '../inventory/entities/inventory-item.entity';
import { InventoryItemAssetEntity } from '../inventory/entities/inventory-item-asset.entity';
import { MetricConceptAliasEntity } from './entities/metric-concept-alias.entity';
import { MetricConceptEntity } from './entities/metric-concept.entity';
import { MetricConceptMemberEntity } from './entities/metric-concept-member.entity';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { MetricWatchEntity } from './entities/metric-watch.entity';
import { AlertEntity } from '../alerts/entities/alert.entity';
import { MetricWatchCheckerService } from './metric-watch-checker.service';
import { TrendWarningService } from './trend-warning.service';
import { MetricDescriptionBackfillService } from './metric-description-backfill.service';
import { MetricDescriptionService } from './metric-description.service';
import { MetricAnalyzerResponderService } from './metric-understanding/metric-analyzer-responder.service';
import { MetricQualityDetectorService } from './metric-understanding/metric-quality-detector.service';
import { MetricUnderstandingService } from './metric-understanding/metric-understanding.service';
import { MetricsCatalogService } from './metrics-catalog.service';
import { MetricsConceptExecutionService } from './metrics-concept-execution.service';
import { MetricsSemanticBootstrapService } from './metrics-semantic-bootstrap.service';
import { MetricsSemanticClusterService } from './metrics-semantic-cluster.service';
import { MetricsController } from './metrics.controller';
import { MetricsSemanticCatalogService } from './metrics-semantic-catalog.service';
import { MetricsService } from './metrics.service';

@Module({
  imports: [
    IntegrationsModule,
    TypeOrmModule.forFeature([
      ShipEntity,
      AssetEntity,
      ServiceRuleEntity,
      ShipMetricCatalogEntity,
      MetricConceptEntity,
      MetricConceptAliasEntity,
      MetricConceptMemberEntity,
      PmsTaskEntity,
      ComplianceDocEntity,
      ComplianceDocTypeEntity,
      InventoryItemEntity,
      InventoryItemAssetEntity,
      MetricWatchEntity,
      AlertEntity,
    ]),
  ],
  controllers: [MetricsController],
  providers: [
    MetricsService,
    MetricsCatalogService,
    MetricsConceptExecutionService,
    MetricsSemanticBootstrapService,
    MetricsSemanticClusterService,
    MetricsSemanticCatalogService,
    MetricDescriptionService,
    MetricDescriptionBackfillService,
    MetricUnderstandingService,
    MetricAnalyzerResponderService,
    MetricWatchCheckerService,
    TrendWarningService,
    MetricQualityDetectorService,
  ],
  exports: [
    MetricsService,
    MetricsCatalogService,
    MetricsConceptExecutionService,
    MetricsSemanticBootstrapService,
    MetricsSemanticClusterService,
    MetricsSemanticCatalogService,
    MetricDescriptionService,
    MetricDescriptionBackfillService,
    MetricUnderstandingService,
    MetricAnalyzerResponderService,
    MetricQualityDetectorService,
  ],
})
export class MetricsModule {}
