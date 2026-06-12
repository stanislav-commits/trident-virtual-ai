import { Module } from '@nestjs/common';
import { GrafanaLlmModule } from './grafana-llm/grafana-llm.module';
import { InfluxModule } from './influx/influx.module';
import { LlmModule } from './llm/llm.module';
import { PostgresModule } from './postgres/postgres.module';
import { RagModule } from './rag/rag.module';
import { TranscriptionModule } from './transcription/transcription.module';
import { WebSearchModule } from './web-search/web-search.module';
import { WindyModule } from './windy/windy.module';

@Module({
  imports: [
    PostgresModule,
    InfluxModule,
    RagModule,
    TranscriptionModule,
    WebSearchModule,
    LlmModule,
    GrafanaLlmModule,
    WindyModule,
  ],
  exports: [
    PostgresModule,
    InfluxModule,
    RagModule,
    TranscriptionModule,
    WebSearchModule,
    LlmModule,
    GrafanaLlmModule,
    WindyModule,
  ],
})
export class IntegrationsModule {}
