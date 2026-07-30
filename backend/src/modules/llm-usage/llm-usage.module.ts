import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LlmUsageEntity } from './entities/llm-usage.entity';
import { LlmUsageQueryService } from './llm-usage-query.service';
import { LlmUsageRecorderService } from './llm-usage-recorder.service';

/**
 * Global because the recorder is used from `LlmService`, which sits in
 * integrations and is itself imported almost everywhere. Making the recorder
 * available without another import edge keeps the dependency arrow pointing one
 * way: integrations know how to report spend, they do not know who reads it.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([LlmUsageEntity])],
  providers: [LlmUsageRecorderService, LlmUsageQueryService],
  exports: [LlmUsageRecorderService, LlmUsageQueryService],
})
export class LlmUsageModule {}
