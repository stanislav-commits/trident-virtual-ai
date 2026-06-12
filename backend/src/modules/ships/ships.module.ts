import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InfluxModule } from '../../integrations/influx/influx.module';
import { AssetEntity } from '../assets/entities/asset.entity';
import { MetricsModule } from '../metrics/metrics.module';
import { UserEntity } from '../users/entities/user.entity';
import { ShipOrganizationsService } from './ship-organizations.service';
import { ShipContextService } from './ship-context.service';
import { ShipsCommandService } from './ships-command.service';
import { ShipsQueryService } from './ships-query.service';
import { ShipEntity } from './entities/ship.entity';
import { ShipsController } from './ships.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([ShipEntity, UserEntity, AssetEntity]),
    InfluxModule,
    MetricsModule,
  ],
  controllers: [ShipsController],
  providers: [
    ShipsQueryService,
    ShipsCommandService,
    ShipOrganizationsService,
    ShipContextService,
  ],
  exports: [
    ShipsQueryService,
    ShipsCommandService,
    ShipContextService,
    TypeOrmModule,
  ],
})
export class ShipsModule {}
