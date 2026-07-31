import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InfluxModule } from '../../integrations/influx/influx.module';
import { AssetEntity } from '../assets/entities/asset.entity';
import { ComplianceEventsModule } from '../compliance/compliance-events.module';
import { MetricsModule } from '../metrics/metrics.module';
import { UserEntity } from '../users/entities/user.entity';
import { ShipOrganizationsService } from './ship-organizations.service';
import { ShipPhotoService } from './ship-photo.service';
import { ShipPhotoStorageService } from './ship-photo-storage.service';
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
    // v60 Phase 4: ship identity changes produce compliance events. The
    // events module is leaf-shaped (entities only) — importing the full
    // ComplianceModule here closed a Ships→…→Users→Ships module cycle.
    ComplianceEventsModule,
  ],
  controllers: [ShipsController],
  providers: [
    ShipsQueryService,
    ShipsCommandService,
    ShipOrganizationsService,
    ShipContextService,
    ShipPhotoService,
    ShipPhotoStorageService,
  ],
  exports: [
    ShipsQueryService,
    ShipsCommandService,
    ShipContextService,
    TypeOrmModule,
  ],
})
export class ShipsModule {}
