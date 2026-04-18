import { Injectable } from '@nestjs/common';
import { AssistantFallbackWriterService } from '../../assistant-text/assistant-fallback-writer.service';

@Injectable()
export class ChatV2UnsupportedShipTaskResponderService {
  constructor(
    private readonly fallbackWriter: AssistantFallbackWriterService,
  ) {}

  async respond(params: {
    language?: string | null;
    userQuery?: string;
  }): Promise<{ content: string }> {
    return {
      content: await this.fallbackWriter.write({
        language: params.language,
        key: 'fallback.unsupported_ship_task',
        userQuery: params.userQuery,
      }),
    };
  }
}
