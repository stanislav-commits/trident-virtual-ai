import { Module } from '@nestjs/common';
import { RagflowService } from './ragflow.service';

@Module({
  providers: [RagflowService],
  exports: [RagflowService],
})
export class RagflowModule {}
