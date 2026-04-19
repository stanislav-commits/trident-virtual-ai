import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class InfluxHttpService {
  constructor(private readonly configService: ConfigService) {}

  async requestJson<T>(
    pathname: string,
    token: string,
    query?: Record<string, string>,
  ): Promise<T> {
    const baseUrl = this.configService.get<string>('integrations.influx.url', '');

    if (!baseUrl) {
      throw new Error('Influx URL is not configured');
    }

    const url = new URL(pathname, baseUrl);

    Object.entries(query ?? {}).forEach(([key, value]) => {
      if (value.trim()) {
        url.searchParams.set(key, value);
      }
    });

    const response = await fetch(url, {
      headers: {
        Authorization: `Token ${token}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        body || `Influx request failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as T;
  }
}
