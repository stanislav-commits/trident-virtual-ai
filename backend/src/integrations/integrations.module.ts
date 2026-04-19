import { Module } from '@nestjs/common';
import { GrafanaLlmModule } from './grafana-llm/grafana-llm.module';
import { InfluxModule } from './influx/influx.module';
import { LlmModule } from './llm/llm.module';
import { PostgresModule } from './postgres/postgres.module';
import { RagModule } from './rag/rag.module';
import { WebSearchModule } from './web-search/web-search.module';

@Module({
  imports: [
    PostgresModule,
    InfluxModule,
    RagModule,
    WebSearchModule,
    LlmModule,
    GrafanaLlmModule,
  ],
  exports: [
    PostgresModule,
    InfluxModule,
    RagModule,
    WebSearchModule,
    LlmModule,
    GrafanaLlmModule,
  ],
})
export class IntegrationsModule {}
