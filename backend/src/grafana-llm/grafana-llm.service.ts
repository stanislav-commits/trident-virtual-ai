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
  private cooldownUntil = 0;
  private lastCooldownLogAt = 0;
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

  getCooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  async createChatCompletion(
    input: GrafanaChatCompletionInput,
  ): Promise<string | null> {
    if (!this.client) {
      return null;
    }

    if (this.getCooldownRemainingMs() > 0) {
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

  private enterCooldownFromError(error: unknown): number {
    const cooldownMs = this.extractCooldownMs(error);
    if (cooldownMs <= 0) {
      return 0;
    }

    const nextCooldownUntil = Date.now() + cooldownMs;
    this.cooldownUntil = Math.max(this.cooldownUntil, nextCooldownUntil);
    return this.getCooldownRemainingMs();
  }

  private extractCooldownMs(error: unknown): number {
    const message = error instanceof Error ? error.message : String(error);
    const status = this.extractStatusCode(error);
    const looksRateLimited =
      status === 429 ||
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

    const oneRequestMs = (1 / refillRate) * 1000;
    const bufferedCooldownMs = Math.ceil(oneRequestMs * 1.2);
    return Math.min(Math.max(bufferedCooldownMs, 60 * 1000), 30 * 60 * 1000);
  }

  private extractStatusCode(error: unknown): number | null {
    if (!error || typeof error !== 'object') {
      return null;
    }

    const candidate = error as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
      cause?: { status?: unknown; statusCode?: unknown };
    };
    const values = [
      candidate.status,
      candidate.statusCode,
      candidate.response?.status,
      candidate.cause?.status,
      candidate.cause?.statusCode,
    ];

    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
    }

    return null;
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
      )} before retrying requests.`,
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
