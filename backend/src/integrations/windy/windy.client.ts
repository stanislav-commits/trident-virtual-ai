import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Windy Point Forecast API client.
 * Docs: https://api.windy.com/point-forecast/docs
 *
 * The endpoint accepts a single coordinate + a list of parameters and
 * returns hourly forecast arrays for the next 10 days. Free tier is
 * generous (500 req/day) so the chat tool can fan out across a few
 * waypoints without rate-limit concerns.
 *
 * Model choice: `gfsWave` is the default because it's the only free
 * model that includes wave/swell — critical for marine routing. Pure
 * `gfs` is faster/wider but no waves; we only fall back to it if waves
 * aren't requested.
 */

export type WindyModel =
  | 'gfs'
  | 'gfsWave'
  | 'ecmwf'
  | 'iconEu'
  | 'iconD2'
  | 'arome';

/** Windy parameter names. Combined sea state lives under "waves". */
export type WindyParameter =
  | 'temp'
  | 'wind'
  | 'windGust'
  | 'waves'
  | 'swell1'
  | 'pressure'
  | 'precip'
  | 'rh'
  | 'lclouds';

export interface WindyForecastInput {
  lat: number;
  lon: number;
  model?: WindyModel;
  parameters: WindyParameter[];
  /** Surface is the default; deeper levels are paid tier only. */
  levels?: Array<'surface'>;
}

/**
 * Raw Windy response shape (the API returns each parameter as its own
 * named field with a `ts` (epoch ms) array and one or more value arrays
 * named like `wind_u-surface`, `wind_v-surface`, `waves_height-surface`).
 * We pass this through to a normalizer that's easier for the LLM to use.
 */
export interface WindyForecastResponse {
  ts: number[];
  units: Record<string, string>;
  [field: string]: unknown;
}

@Injectable()
export class WindyClient {
  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return Boolean(this.getApiKey());
  }

  async pointForecast(
    input: WindyForecastInput,
  ): Promise<WindyForecastResponse> {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'WINDY_API_KEY is not configured — cannot fetch marine forecast.',
      );
    }

    const body = {
      lat: input.lat,
      lon: input.lon,
      model: input.model ?? 'gfsWave',
      parameters: input.parameters,
      levels: input.levels ?? ['surface'],
      key: apiKey,
    };

    const url = `${this.getBaseUrl()}/api/point-forecast/v2`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new ServiceUnavailableException(
        `Windy ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    return (await response.json()) as WindyForecastResponse;
  }

  private getApiKey(): string {
    return this.configService
      .get<string>('integrations.windy.apiKey', '')
      .trim();
  }

  private getBaseUrl(): string {
    return (
      this.configService.get<string>('integrations.windy.baseUrl', '').trim() ||
      'https://api.windy.com'
    );
  }
}
