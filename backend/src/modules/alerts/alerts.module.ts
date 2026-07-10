import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AlertEntity } from './entities/alert.entity';
import { ShipMetricCatalogEntity } from '../metrics/entities/ship-metric-catalog.entity';
import { AssetEntity } from '../assets/entities/asset.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { AlertsService } from './alerts.service';
import { AlertsSchedulerService } from './alerts-scheduler.service';
import { AlertsController, AlertsWebhookController } from './alerts.controller';
import { PmsModule } from '../pms/pms.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { AccessControlModule } from '../access-control/access-control.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AlertEntity,
      ShipMetricCatalogEntity,
      AssetEntity,
      ShipEntity,
    ]),
    PmsModule,
    ComplianceModule,
    AccessControlModule,
  ],
  controllers: [AlertsWebhookController, AlertsController],
  providers: [AlertsService, AlertsSchedulerService],
  exports: [AlertsService],
})
export class AlertsModule {}
