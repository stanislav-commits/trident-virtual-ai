import { Module } from '@nestjs/common';
import { RagflowClient } from './ragflow.client';
import { RagService } from './rag.service';

@Module({
  providers: [RagService, RagflowClient],
  exports: [RagService],
})
export class RagModule {}
