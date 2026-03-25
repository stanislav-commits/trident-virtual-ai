import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

interface GrafanaChatCompletionInput {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  model?: string;
}

@Injectable()
export class GrafanaLlmService {
  private readonly logger = new Logger(GrafanaLlmService.name);
  private readonly apiKey = process.env.GRAFANA_SA_TOKEN?.trim() || '';
  private readonly baseUrl = process.env.GRAFANA_LLM_BASE_URL?.trim() || '';
  private readonly defaultModel =
    process.env.GRAFANA_LLM_MODEL?.trim() || 'gpt-4o';
  private readonly client =
    this.apiKey && this.baseUrl
      ? new OpenAI({
          apiKey: this.apiKey,
          baseURL: this.baseUrl,
        })
      : null;

  isConfigured(): boolean {
    return Boolean(this.client);
  }

  async createChatCompletion(
    input: GrafanaChatCompletionInput,
  ): Promise<string | null> {
    if (!this.client) {
      return null;
    }

    try {
      const response = await this.client.chat.completions.create({
        model: input.model?.trim() || this.defaultModel,
        temperature: input.temperature ?? 0.2,
        max_tokens: input.maxTokens ?? 80,
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: input.userPrompt },
        ],
      });

      return response.choices[0]?.message?.content?.trim() || null;
    } catch (error) {
      this.logger.warn(
        `Grafana LLM request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
