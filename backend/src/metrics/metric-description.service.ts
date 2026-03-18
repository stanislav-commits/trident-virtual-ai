import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import type { InfluxMetric } from '../influxdb/influxdb.service';

@Injectable()
export class MetricDescriptionService {
  private readonly logger = new Logger(MetricDescriptionService.name);
  private readonly model = process.env.LLM_MODEL || 'gpt-4o-mini';
  private readonly client = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

  isConfigured(): boolean {
    return Boolean(this.client);
  }

  async generateDescription(metric: InfluxMetric): Promise<string | null> {
    if (!this.client) return null;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.2,
        max_tokens: 80,
        messages: [
          {
            role: 'system',
            content:
              'You write concise telemetry metric descriptions for marine dashboards. ' +
              'Use the provided bucket, measurement, field, and label. ' +
              'Do not mention InfluxDB. Do not overclaim when meaning is unclear. ' +
              'Return plain text only, one short sentence, maximum 18 words.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              bucket: metric.bucket,
              measurement: metric.measurement,
              field: metric.field,
              label: metric.label,
            }),
          },
        ],
      });

      return response.choices[0]?.message?.content?.trim() || null;
    } catch (error) {
      this.logger.warn(
        `Metric description generation failed for ${metric.key}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
