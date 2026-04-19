import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationStatusDto } from '../../common/dto/integration-status.dto';

@Injectable()
export class RagService {
  constructor(private readonly configService: ConfigService) {}

  getStatus(): IntegrationStatusDto {
    const provider = this.configService.get<string>('integrations.rag.provider', 'local');
    const indexName = this.configService.get<string>('integrations.rag.indexName');
    return {
      name: 'rag',
      configured: Boolean(indexName),
      reachable: false,
      details: indexName
        ? `RAG provider "${provider}" is configured. Retrieval wiring is still pending.`
        : `RAG provider "${provider}" selected, but no index is configured yet.`,
    };
  }
}
