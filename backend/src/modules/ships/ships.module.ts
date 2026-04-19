import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InfluxModule } from '../../integrations/influx/influx.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ShipOrganizationsService } from './ship-organizations.service';
import { ShipsCommandService } from './ships-command.service';
import { ShipsQueryService } from './ships-query.service';
import { ShipEntity } from './entities/ship.entity';
import { ShipsController } from './ships.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ShipEntity]), InfluxModule, MetricsModule],
  controllers: [ShipsController],
  providers: [ShipsQueryService, ShipsCommandService, ShipOrganizationsService],
  exports: [ShipsQueryService, ShipsCommandService, TypeOrmModule],
})
export class ShipsModule {}
