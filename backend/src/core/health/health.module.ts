import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [IntegrationsModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
