import { Injectable } from '@nestjs/common';
import { GrafanaLlmService } from '../../integrations/grafana-llm/grafana-llm.service';
import {
  buildMetricDescriptionPrompt,
  type MetricDescriptionInput,
  normalizeMetricDescriptionResponse,
} from './metric-description.prompts';

@Injectable()
export class MetricDescriptionService {
  constructor(private readonly grafanaLlmService: GrafanaLlmService) {}

  isConfigured(): boolean {
    return this.grafanaLlmService.isConfigured();
  }

  getBackfillCooldownMs(): number {
    return this.grafanaLlmService.getCooldownRemainingMs();
  }

  async generateDescription(
    metric: MetricDescriptionInput,
  ): Promise<string | null> {
    if (!this.grafanaLlmService.isConfigured()) {
      return null;
    }

    const prompt = buildMetricDescriptionPrompt(metric);
    const raw = await this.grafanaLlmService.createChatCompletion({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      temperature: prompt.temperature,
      maxTokens: prompt.maxTokens,
    });

    return normalizeMetricDescriptionResponse(raw);
  }
}
