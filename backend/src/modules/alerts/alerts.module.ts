import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertEntity } from './entities/alert.entity';
import { AlertAssetBindingEntity } from './entities/alert-asset-binding.entity';
import { ShipMetricCatalogEntity } from '../metrics/entities/ship-metric-catalog.entity';
import { AssetEntity } from '../assets/entities/asset.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { AlertsService } from './alerts.service';
import { AlertsSchedulerService } from './alerts-scheduler.service';
import { GrafanaRulesService } from './grafana-rules.service';
import { AlertsController, AlertsWebhookController } from './alerts.controller';
import { PmsModule } from '../pms/pms.module';
import { MetricsModule } from '../metrics/metrics.module';
import { AlertAutoAnalysisService } from './alert-auto-analysis.service';
import { ComplianceModule } from '../compliance/compliance.module';
import { AccessControlModule } from '../access-control/access-control.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AlertEntity,
      AlertAssetBindingEntity,
      ShipMetricCatalogEntity,
      AssetEntity,
      ShipEntity,
    ]),
    PmsModule,
    MetricsModule,
    ComplianceModule,
    AccessControlModule,
  ],
  controllers: [AlertsWebhookController, AlertsController],
  providers: [
    AlertAutoAnalysisService,
    AlertsService,
    AlertsSchedulerService,
    GrafanaRulesService,
  ],
  exports: [AlertsService],
})
export class AlertsModule {}
