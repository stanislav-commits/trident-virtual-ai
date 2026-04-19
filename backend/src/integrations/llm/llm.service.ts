import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationStatusDto } from '../../common/dto/integration-status.dto';
import { createOpenAiCompatibleChatCompletion } from '../shared/openai-compatible-http';

interface LlmChatCompletionInput {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(private readonly configService: ConfigService) {}

  getStatus(): IntegrationStatusDto {
    const provider = this.configService.get<string>('integrations.llm.provider', 'openai');
    const model = this.configService.get<string>('integrations.llm.model', 'gpt-4.1-mini');
    const hasApiKey = Boolean(this.configService.get<string>('integrations.llm.apiKey'));

    return {
      name: 'llm',
      configured: hasApiKey,
      reachable: false,
      details: hasApiKey
        ? `LLM provider "${provider}" with model "${model}" is configured.`
        : `LLM provider "${provider}" selected, but no API key is configured yet.`,
    };
  }

  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  async createChatCompletion(
    input: LlmChatCompletionInput,
  ): Promise<string | null> {
    if (!this.isConfigured()) {
      return null;
    }

    try {
      return await createOpenAiCompatibleChatCompletion({
        apiKey: this.getApiKey(),
        baseUrl: this.getBaseUrl(),
        model: input.model?.trim() || this.getModel(),
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });
    } catch (error) {
      this.logger.warn(
        `LLM request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async summarize(input: string): Promise<string> {
    const summary = await this.createChatCompletion({
      systemPrompt: 'Summarize the following input in a short and helpful way.',
      userPrompt: input,
      temperature: 0.2,
      maxTokens: 160,
    });

    return summary ?? `LLM summary placeholder: ${input}`;
  }

  private getApiKey(): string {
    return this.configService.get<string>('integrations.llm.apiKey', '').trim();
  }

  private getBaseUrl(): string {
    return (
      this.configService.get<string>('integrations.llm.baseUrl', '').trim() ||
      'https://api.openai.com/v1'
    );
  }

  private getModel(): string {
    return this.configService
      .get<string>('integrations.llm.model', 'gpt-4.1-mini')
      .trim();
  }
}
