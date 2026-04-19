import { Module } from '@nestjs/common';
import { IntegrationsModule } from '../../integrations/integrations.module';
import { WebController } from './web.controller';
import { WebService } from './web.service';

@Module({
  imports: [IntegrationsModule],
  controllers: [WebController],
  providers: [WebService],
  exports: [WebService],
})
export class WebModule {}
