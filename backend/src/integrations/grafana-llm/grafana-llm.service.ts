import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenAiCompatibleChatCompletion } from '../shared/openai-compatible-http';

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
  private cooldownUntil = 0;
  private lastCooldownLogAt = 0;

  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.getApiKey() && this.getBaseUrl());
  }

  getCooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  async createChatCompletion(
    input: GrafanaChatCompletionInput,
  ): Promise<string | null> {
    if (!this.isConfigured()) {
      return null;
    }

    if (this.getCooldownRemainingMs() > 0) {
      return null;
    }

    try {
      return await createOpenAiCompatibleChatCompletion({
        apiKey: this.getApiKey(),
        baseUrl: this.getBaseUrl(),
        model: input.model?.trim() || this.getDefaultModel(),
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
      });
    } catch (error) {
      const cooldownMs = this.enterCooldownFromError(error);

      if (cooldownMs > 0) {
        this.logCooldown(cooldownMs);
      } else {
        this.logger.warn(
          `Grafana LLM request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return null;
    }
  }

  private getApiKey(): string {
    return this.configService
      .get<string>('integrations.grafanaLlm.apiKey', '')
      .trim();
  }

  private getBaseUrl(): string {
    return this.configService
      .get<string>('integrations.grafanaLlm.baseUrl', '')
      .trim();
  }

  private getDefaultModel(): string {
    return this.configService
      .get<string>('integrations.grafanaLlm.model', 'gpt-4o')
      .trim();
  }

  private enterCooldownFromError(error: unknown): number {
    const cooldownMs = this.extractCooldownMs(error);

    if (cooldownMs <= 0) {
      return 0;
    }

    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + cooldownMs);
    return this.getCooldownRemainingMs();
  }

  private extractCooldownMs(error: unknown): number {
    const message = error instanceof Error ? error.message : String(error);
    const looksRateLimited =
      /\b429\b/.test(message) ||
      /rate limit/i.test(message) ||
      /too many requests/i.test(message);

    if (!looksRateLimited) {
      return 0;
    }

    const defaultCooldownMs = 10 * 60 * 1000;
    const refillRateMatch = message.match(
      /([0-9]*\.?[0-9]+)\s+requests?\s+per\s+sec/i,
    );

    if (!refillRateMatch) {
      return defaultCooldownMs;
    }

    const refillRate = Number.parseFloat(refillRateMatch[1]);

    if (!Number.isFinite(refillRate) || refillRate <= 0) {
      return defaultCooldownMs;
    }

    const requestWindowMs = (1 / refillRate) * 1000;
    return Math.min(
      Math.max(Math.ceil(requestWindowMs * 1.2), 60 * 1000),
      30 * 60 * 1000,
    );
  }

  private logCooldown(cooldownMs: number) {
    const now = Date.now();

    if (now - this.lastCooldownLogAt < 60 * 1000) {
      return;
    }

    this.lastCooldownLogAt = now;
    this.logger.warn(
      `Grafana LLM rate limited, cooling down for ${this.formatDuration(
        cooldownMs,
      )} before retrying metric descriptions.`,
    );
  }

  private formatDuration(durationMs: number): string {
    const totalSeconds = Math.max(1, Math.ceil(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes === 0) {
      return `${seconds}s`;
    }

    if (seconds === 0) {
      return `${minutes}m`;
    }

    return `${minutes}m ${seconds}s`;
  }
}
