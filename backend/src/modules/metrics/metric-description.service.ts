import { Injectable } from '@nestjs/common';
import { LlmService } from '../../integrations/llm/llm.service';
import {
  buildMetricDescriptionPrompt,
  type MetricDescriptionInput,
  normalizeMetricDescriptionResponse,
} from './metric-description.prompts';

/**
 * Written by the main model. These descriptions are what a metric name means to
 * a person — the same reading the chat model does when it answers about that
 * metric — so they come from the same model rather than a second one wired to
 * a different provider.
 */
@Injectable()
export class MetricDescriptionService {
  constructor(private readonly llmService: LlmService) {}

  isConfigured(): boolean {
    return this.llmService.isConfigured();
  }

  /** No provider-side cooldown to wait out any more. */
  getBackfillCooldownMs(): number {
    return 0;
  }

  async generateDescription(
    metric: MetricDescriptionInput,
  ): Promise<string | null> {
    if (!this.llmService.isConfigured()) {
      return null;
    }

    const prompt = buildMetricDescriptionPrompt(metric);
    const raw = await this.llmService.createChatCompletion({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      temperature: prompt.temperature,
      maxTokens: prompt.maxTokens,
      preferMainModel: true,
    });

    return normalizeMetricDescriptionResponse(raw);
  }
}
