import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssetEntity } from '../assets/entities/asset.entity';
import { UserEntity } from '../users/entities/user.entity';
import { PmsController } from './pms.controller';
import { PmsService } from './pms.service';
import { PmsTaskEntity } from './entities/pms-task.entity';
import { AssetHoursConfigEntity } from './entities/asset-hours-config.entity';
import { AssetHourReadingEntity } from './entities/asset-hour-reading.entity';
import { AssetHoursService } from './asset-hours.service';
import { PmsImportService } from './pms-import.service';
import { ShipMetricCatalogEntity } from '../metrics/entities/ship-metric-catalog.entity';
import { ShipEntity } from '../ships/entities/ship.entity';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { CrewModule } from '../crew/crew.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      PmsTaskEntity,
      AssetEntity,
      UserEntity,
      AssetHoursConfigEntity,
      AssetHourReadingEntity,
      ShipMetricCatalogEntity,
      ShipEntity,
    ]),
    IntegrationsModule,
    CrewModule,
    InventoryModule,
  ],
  controllers: [PmsController],
  providers: [PmsService, AssetHoursService, PmsImportService],
  exports: [PmsService, AssetHoursService],
})
export class PmsModule {}
