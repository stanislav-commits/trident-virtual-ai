import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { GrafanaLlmService } from '../grafana-llm/grafana-llm.service';
import {
  buildMetricDescriptionPrompt,
  type MetricDescriptionInput,
  normalizeMetricDescriptionResponse,
} from './metric-description.prompts';

type MetricDescriptionProvider = 'auto' | 'grafana' | 'openai';

@Injectable()
export class MetricDescriptionService {
  private readonly logger = new Logger(MetricDescriptionService.name);
  private readonly provider = this.readProvider();
  private readonly openAiModel = process.env.LLM_MODEL || 'gpt-4o-mini';
  private readonly openAiClient = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

  constructor(private readonly grafanaLlm: GrafanaLlmService) {}

  isConfigured(): boolean {
    if (this.provider === 'grafana') {
      return this.grafanaLlm.isConfigured();
    }

    if (this.provider === 'openai') {
      return Boolean(this.openAiClient);
    }

    return this.grafanaLlm.isConfigured() || Boolean(this.openAiClient);
  }

  getBackfillCooldownMs(): number {
    if (this.provider === 'grafana') {
      return this.grafanaLlm.getCooldownRemainingMs();
    }

    if (this.provider === 'openai') {
      return 0;
    }

    return this.openAiClient ? 0 : this.grafanaLlm.getCooldownRemainingMs();
  }

  async generateDescription(
    metric: MetricDescriptionInput,
  ): Promise<string | null> {
    if (this.provider === 'grafana') {
      return this.generateViaGrafana(metric);
    }

    if (this.provider === 'openai') {
      return this.generateViaOpenAi(metric);
    }

    const deterministic = this.buildDeterministicDescription(metric);
    if (deterministic) {
      return deterministic;
    }

    for (const provider of this.getProviderOrder()) {
      const description =
        provider === 'grafana'
          ? await this.generateViaGrafana(metric)
          : await this.generateViaOpenAi(metric);
      if (description) {
        return description;
      }
    }

    return this.buildFallbackDescription(metric);
  }

  private buildDeterministicDescription(
    metric: MetricDescriptionInput,
  ): string | null {
    const primaryText = this.normalizeText(
      [metric.field, metric.label, metric.key].filter(Boolean).join(' '),
    );
    const tankLabel = this.getDedicatedTankDisplayLabel(metric);

    if (tankLabel) {
      return `Displays the current reading for ${tankLabel}.`;
    }

    if (/\b(latitude|lat)\b/.test(primaryText)) {
      return "Displays the vessel's current latitude.";
    }

    if (/\b(longitude|lon)\b/.test(primaryText)) {
      return "Displays the vessel's current longitude.";
    }

    const subject = this.extractPrimarySubject(metric);
    if (!subject) {
      return null;
    }

    if (/\btemperature\b/.test(primaryText)) {
      return `Displays the current ${subject} temperature.`;
    }
    if (/\bpressure\b/.test(primaryText)) {
      return `Displays the current ${subject} pressure.`;
    }
    if (/\bvoltage\b/.test(primaryText)) {
      return `Displays the current ${subject} voltage.`;
    }
    if (/\b(current|amperage|amps?|amp)\b/.test(primaryText)) {
      return `Displays the current ${subject} current.`;
    }
    if (
      /\b(level|quantity|volume|contents?|remaining|available)\b/.test(
        primaryText,
      )
    ) {
      return `Displays the current ${subject} level.`;
    }
    if (/\b(rate|flow|consumption|used)\b/.test(primaryText)) {
      return `Displays the current ${subject} reading.`;
    }
    if (/\b(hours?|runtime|running hours?)\b/.test(primaryText)) {
      return `Displays the current ${subject} hours reading.`;
    }
    if (/\b(rpm|speed)\b/.test(primaryText)) {
      return `Displays the current ${subject} speed reading.`;
    }
    if (/\b(status|state)\b/.test(primaryText)) {
      return `Displays the current ${subject} status.`;
    }

    return null;
  }

  private buildFallbackDescription(
    metric: MetricDescriptionInput,
  ): string | null {
    const subject = this.extractPrimarySubject(metric);
    if (!subject) {
      return null;
    }

    return `Displays the current ${subject} reading.`;
  }

  private readProvider(): MetricDescriptionProvider {
    const value =
      process.env.METRIC_DESCRIPTION_PROVIDER?.trim().toLowerCase() || 'auto';

    if (value === 'auto' || value === 'grafana' || value === 'openai') {
      return value;
    }

    this.logger.warn(
      `Ignoring unsupported METRIC_DESCRIPTION_PROVIDER="${value}", using "auto"`,
    );
    return 'auto';
  }

  private getProviderOrder(): Array<
    Exclude<MetricDescriptionProvider, 'auto'>
  > {
    return ['grafana', 'openai'];
  }

  private async generateViaGrafana(
    metric: MetricDescriptionInput,
  ): Promise<string | null> {
    if (!this.grafanaLlm.isConfigured()) {
      return null;
    }

    const prompt = buildMetricDescriptionPrompt(metric);
    const raw = await this.grafanaLlm.createChatCompletion({
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      temperature: prompt.temperature,
      maxTokens: prompt.maxTokens,
    });
    return normalizeMetricDescriptionResponse(raw);
  }

  private async generateViaOpenAi(
    metric: MetricDescriptionInput,
  ): Promise<string | null> {
    if (!this.openAiClient) {
      return null;
    }

    const prompt = buildMetricDescriptionPrompt(metric);

    try {
      const response = await this.openAiClient.chat.completions.create({
        model: this.openAiModel,
        temperature: prompt.temperature,
        max_tokens: prompt.maxTokens,
        messages: [
          { role: 'system', content: prompt.systemPrompt },
          { role: 'user', content: prompt.userPrompt },
        ],
      });

      return normalizeMetricDescriptionResponse(
        response.choices[0]?.message?.content?.trim() || null,
      );
    } catch (error) {
      this.logger.warn(
        `Metric description generation failed for ${metric.key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private extractPrimarySubject(metric: MetricDescriptionInput): string | null {
    const rawSubject =
      this.pickPrimaryMetricText(metric.field) ??
      this.pickPrimaryMetricText(metric.label) ??
      this.pickPrimaryMetricText(metric.key) ??
      this.pickPrimaryMetricText(metric.measurement);
    if (!rawSubject) {
      return null;
    }

    const normalized = this.normalizeText(rawSubject)
      .replace(
        /\b(latitude|lat|longitude|lon|temperature|temp|pressure|voltage|current|amps?|amp|level|quantity|volume|contents?|remaining|available|rate|flow|consumption|used|hours?|runtime|running|rpm|speed|status|state|value|reading)\b/g,
        ' ',
      )
      .replace(/\s+/g, ' ')
      .trim();

    const display = normalized || this.normalizeText(rawSubject);
    const limited = display.split(/\s+/).filter(Boolean).slice(0, 4).join(' ');

    return limited || null;
  }

  private pickPrimaryMetricText(value?: string | null): string | null {
    if (!value?.trim()) {
      return null;
    }

    const lastSegment = value.split('.').pop()?.trim() ?? value.trim();
    if (lastSegment) {
      return lastSegment;
    }

    return value.trim();
  }

  private getDedicatedTankDisplayLabel(
    metric: MetricDescriptionInput,
  ): string | null {
    const rawField =
      metric.field?.trim() ||
      metric.label?.split('.').slice(-1)[0]?.trim() ||
      metric.key.split('::').slice(-1)[0]?.trim() ||
      '';
    if (!rawField) {
      return null;
    }

    const normalized = this.normalizeText(rawField);
    if (!/\btank\b/.test(normalized)) {
      return null;
    }

    if (
      /\b(sensor|switch|alarm|temperature|temp|pressure|rate|flow|used|consumption|power|voltage|current|factor)\b/.test(
        normalized,
      )
    ) {
      return null;
    }

    const dedicatedTankPattern =
      /^((fresh|dirty|clean|black|grey|bilge)\s+)*(fuel|oil|water|coolant|def|urea)\s+tank(\s+[a-z0-9]+)?(\s+liters?)?$/i;
    if (!dedicatedTankPattern.test(normalized)) {
      return null;
    }

    return rawField.replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private normalizeText(value: string): string {
    return value
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_./:-]+/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/[^a-zA-Z0-9\s]+/g, ' ')
      .replace(/\btemps?\b/g, ' temperature ')
      .replace(/\bvolt(s)?\b/g, ' voltage ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
}
