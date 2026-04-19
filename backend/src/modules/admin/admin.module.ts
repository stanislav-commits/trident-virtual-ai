import { Module } from '@nestjs/common';
import { HealthModule } from '../../core/health/health.module';
import { ShipsModule } from '../ships/ships.module';
import { UsersModule } from '../users/users.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [HealthModule, UsersModule, ShipsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
