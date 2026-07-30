import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LlmModelPriceEntity } from './entities/llm-model-price.entity';
import { LlmUsageEntity } from './entities/llm-usage.entity';
import { LlmPriceBookService } from './llm-price-book.service';
import { LlmPricesController } from './llm-prices.controller';
import { ManualsCostImportService } from './manuals-cost-import.service';
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
  imports: [TypeOrmModule.forFeature([LlmUsageEntity, LlmModelPriceEntity])],
  controllers: [LlmPricesController],
  providers: [
    LlmUsageRecorderService,
    LlmUsageQueryService,
    LlmPriceBookService,
    ManualsCostImportService,
  ],
  exports: [
    LlmUsageRecorderService,
    LlmUsageQueryService,
    LlmPriceBookService,
    ManualsCostImportService,
  ],
})
export class LlmUsageModule {}
