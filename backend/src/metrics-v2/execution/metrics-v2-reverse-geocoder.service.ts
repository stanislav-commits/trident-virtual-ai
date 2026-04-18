import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class MetricsV2ReverseGeocoderService {
  private readonly logger = new Logger(MetricsV2ReverseGeocoderService.name);

  async reverseGeocode(params: {
    latitude: number;
    longitude: number;
  }): Promise<string | null> {
    const { latitude, longitude } = params;

    try {
      const url = new URL('https://nominatim.openstreetmap.org/reverse');
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('lat', String(latitude));
      url.searchParams.set('lon', String(longitude));
      url.searchParams.set('zoom', '14');
      url.searchParams.set('addressdetails', '1');

      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Trident-Intelligence/1.0 (chat-v2 telemetry)',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Reverse geocoder returned ${response.status}`);
      }

      const payload = (await response.json()) as {
        display_name?: unknown;
        address?: Record<string, unknown>;
      };

      return this.buildHumanLocation(payload);
    } catch (error) {
      this.logger.warn(
        `Reverse geocoding failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private buildHumanLocation(payload: {
    display_name?: unknown;
    address?: Record<string, unknown>;
  }): string | null {
    const address = payload.address ?? {};
    const locality = this.pickString(
      address.hamlet,
      address.suburb,
      address.neighbourhood,
      address.city,
      address.town,
      address.village,
      address.municipality,
      address.county,
      address.state_district,
      address.state,
    );
    const region = this.pickString(address.county, address.state_district, address.state);
    const country = this.pickString(address.country);

    const summary = [locality, region, country].filter(Boolean).join(', ').trim();
    if (summary) {
      return summary;
    }

    if (typeof payload.display_name === 'string' && payload.display_name.trim()) {
      return payload.display_name.trim();
    }

    return null;
  }

  private pickString(...values: unknown[]): string | null {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }

    return null;
  }
}
