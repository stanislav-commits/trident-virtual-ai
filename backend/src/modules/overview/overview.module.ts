import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShipEntity } from '../ships/entities/ship.entity';
import { AlertsAggregator } from './aggregators/alerts.aggregator';
import { AssetsOverviewAggregator } from './aggregators/assets.aggregator';
import { ComplianceAggregator } from './aggregators/compliance.aggregator';
import { CrewAggregator } from './aggregators/crew.aggregator';
import { InventoryAggregator } from './aggregators/inventory.aggregator';
import { KnowledgeAggregator } from './aggregators/knowledge.aggregator';
import { MaintenanceAggregator } from './aggregators/maintenance.aggregator';
import { MetricsOverviewAggregator } from './aggregators/metrics.aggregator';
import { TasksAggregator } from './aggregators/tasks.aggregator';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';

/**
 * No domain module is imported on purpose: each aggregator owns one SQL
 * statement over the tables it reports on, so pulling in the domain services
 * would drag their integrations (Influx, RAGFlow, Grafana) into a page that must
 * never make an outbound call.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ShipEntity])],
  controllers: [OverviewController],
  providers: [
    OverviewService,
    AssetsOverviewAggregator,
    ComplianceAggregator,
    MaintenanceAggregator,
    TasksAggregator,
    CrewAggregator,
    InventoryAggregator,
    AlertsAggregator,
    KnowledgeAggregator,
    MetricsOverviewAggregator,
  ],
})
export class OverviewModule {}
