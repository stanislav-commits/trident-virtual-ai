import { Module } from '@nestjs/common';
import { RagflowModule } from '../ragflow/ragflow.module';
import { ManualsService } from './manuals.service';
import { ShipsController } from './ships.controller';
import { ShipsService } from './ships.service';

@Module({
  imports: [RagflowModule],
  controllers: [ShipsController],
  providers: [ShipsService, ManualsService],
  exports: [ShipsService],
})
export class ShipsModule {}
