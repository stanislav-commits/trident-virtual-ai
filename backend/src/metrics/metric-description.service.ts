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
    const deterministic = this.buildDeterministicDescription(metric);
    if (deterministic) {
      return deterministic;
    }

    if (!this.client) {
      return this.buildFallbackDescription(metric);
    }

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
              'Use the provided key, bucket, measurement, field, and label. ' +
              'Treat bucket and measurement as grouping context only; prefer field and label when they conflict. ' +
              'Do not infer temperature, pressure, level, or status from a grouping name alone. ' +
              'If the field or label looks like a dedicated tank identifier such as Fuel_Tank_1P, describe it as a tank reading unless the field or label explicitly says temperature. ' +
              'Do not mention InfluxDB. Do not overclaim when meaning is unclear. ' +
              'Return plain text only, one short sentence, maximum 18 words.',
          },
          {
            role: 'user',
            content: JSON.stringify({
              key: metric.key,
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

  private buildDeterministicDescription(metric: InfluxMetric): string | null {
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
    if (/\b(level|quantity|volume|contents?|remaining|available)\b/.test(primaryText)) {
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

  private buildFallbackDescription(metric: InfluxMetric): string | null {
    const subject = this.extractPrimarySubject(metric);
    if (!subject) {
      return null;
    }

    return `Displays the current ${subject} reading.`;
  }

  private extractPrimarySubject(metric: InfluxMetric): string | null {
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
    const limited = display
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .join(' ');

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

  private getDedicatedTankDisplayLabel(metric: InfluxMetric): string | null {
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
