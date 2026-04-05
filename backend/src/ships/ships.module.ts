import { Module } from '@nestjs/common';
import { MetricsModule } from '../metrics/metrics.module';
import { RagflowModule } from '../ragflow/ragflow.module';
import { TagsModule } from '../tags/tags.module';
import { ManualsParseScheduler } from './manuals-parse.scheduler';
import { ManualsService } from './manuals.service';
import { ShipsController } from './ships.controller';
import { ShipsService } from './ships.service';

@Module({
  imports: [RagflowModule, MetricsModule, TagsModule],
  controllers: [ShipsController],
  providers: [ShipsService, ManualsService, ManualsParseScheduler],
  exports: [ShipsService],
})
export class ShipsModule {}
