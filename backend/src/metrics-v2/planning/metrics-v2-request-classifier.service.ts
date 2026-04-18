import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  MetricsV2RequestClassification,
  MetricsV2RequestKind,
} from '../metrics-v2.types';

type RawMetricsClassification = Partial<{
  kind: unknown;
  confidence: unknown;
  reason: unknown;
}>;

@Injectable()
export class MetricsV2RequestClassifierService {
  private readonly logger = new Logger(MetricsV2RequestClassifierService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.model =
      process.env.METRICS_V2_REQUEST_CLASSIFIER_MODEL ||
      process.env.LLM_MODEL ||
      'gpt-4o-mini';
  }

  async classify(params: {
    userQuery: string;
    recentMessages: Array<{ role: string; content: string }>;
  }): Promise<MetricsV2RequestClassification> {
    const { userQuery, recentMessages } = params;

    try {
      const outputText = await this.classifyWithLlm({ userQuery, recentMessages });
      return this.parseClassification(outputText);
    } catch (error) {
      this.logger.warn(
        `Metrics v2 request classification failed; treating ship task as not-metrics: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return {
        kind: 'not_metrics',
        confidence: 0,
        reason: 'Metrics classification failed before a safe metrics plan could be built.',
      };
    }
  }

  private async classifyWithLlm(params: {
    userQuery: string;
    recentMessages: Array<{ role: string; content: string }>;
  }): Promise<string> {
    if (!this.client) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    const recentContext = params.recentMessages
      .slice(-6)
      .map((message) => `${message.role}: ${message.content.trim()}`)
      .join('\n');

    const response = await this.client.responses.create({
      model: this.model,
      temperature: 0,
      max_output_tokens: 220,
      instructions:
        'Classify whether a ship-related user request is specifically about vessel metrics/telemetry.\n' +
        'Return ONLY valid JSON with this shape: {"kind":"metrics_request"|"not_metrics","confidence":0..1,"reason":"short reason"}.\n' +
        'Choose metrics_request when the user asks for current readings, levels, quantities, runtime, pressure, temperature, speed, position, voltage, current, power, fuel onboard, tank levels, usage, trends, historical values, averages, deltas, or telemetry analysis.\n' +
        'Choose not_metrics when the user asks for manuals, procedures, bunkering steps, regulations, certificates, troubleshooting instructions, compliance, or narrative documentation.\n' +
        'Examples:\n' +
        '- "what is current yacht speed?" => metrics_request\n' +
        '- "where is the yacht now?" => metrics_request\n' +
        '- "what is the vessel position?" => metrics_request\n' +
        '- "show me latitude and longitude" => metrics_request\n' +
        '- "manual for bunkering" => not_metrics\n' +
        'If unsure, choose not_metrics.',
      input: [
        {
          role: 'user',
          content:
            `Current user message: ${params.userQuery}\n` +
            `Recent prior chat messages:\n${recentContext || '(none)'}`,
        },
      ],
    });

    const outputText = response.output_text?.trim();
    if (!outputText) {
      throw new Error('Empty metrics request classifier response');
    }

    return outputText;
  }

  private parseClassification(outputText: string): MetricsV2RequestClassification {
    const raw = this.parseJsonObject(outputText);

    return {
      kind: this.parseKind(raw.kind),
      confidence: this.parseConfidence(raw.confidence),
      reason:
        typeof raw.reason === 'string' && raw.reason.trim()
          ? raw.reason.trim()
          : 'LLM classified the ship request for metrics-v2.',
    };
  }

  private parseJsonObject(outputText: string): RawMetricsClassification {
    try {
      return JSON.parse(outputText) as RawMetricsClassification;
    } catch {
      const jsonMatch = outputText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Metrics request classifier response did not contain JSON');
      }

      return JSON.parse(jsonMatch[0]) as RawMetricsClassification;
    }
  }

  private parseKind(value: unknown): MetricsV2RequestKind {
    if (value === 'metrics_request' || value === 'not_metrics') {
      return value;
    }

    throw new Error('Metrics request classifier returned an invalid kind');
  }

  private parseConfidence(value: unknown): number {
    const confidence = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(confidence)) {
      return 0.5;
    }

    return Math.max(0, Math.min(1, confidence));
  }
}
