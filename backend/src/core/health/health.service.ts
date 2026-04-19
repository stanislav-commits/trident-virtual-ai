import { Injectable } from '@nestjs/common';
import { InfluxService } from '../../integrations/influx/influx.service';
import { LlmService } from '../../integrations/llm/llm.service';
import { PostgresService } from '../../integrations/postgres/postgres.service';
import { RagService } from '../../integrations/rag/rag.service';
import { WebSearchService } from '../../integrations/web-search/web-search.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly postgresService: PostgresService,
    private readonly influxService: InfluxService,
    private readonly ragService: RagService,
    private readonly webSearchService: WebSearchService,
    private readonly llmService: LlmService,
  ) {}

  getHealth() {
    const integrations = [
      this.postgresService.getStatus(),
      this.influxService.getStatus(),
      this.ragService.getStatus(),
      this.webSearchService.getStatus(),
      this.llmService.getStatus(),
    ];

    return {
      status: integrations.every((item) => item.reachable || !item.configured) ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      integrations,
    };
  }
}
