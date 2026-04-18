import { Injectable } from '@nestjs/common';
import {
  MetricsV2ExecutionBlock,
  MetricsV2ExecutionResult,
  MetricsV2ValueItem,
} from '../metrics-v2.types';
import { MetricsV2ReverseGeocoderService } from './metrics-v2-reverse-geocoder.service';

@Injectable()
export class MetricsV2DerivedAnswerService {
  constructor(
    private readonly reverseGeocoder: MetricsV2ReverseGeocoderService,
  ) {}

  async enrichExecution(
    execution: MetricsV2ExecutionResult,
  ): Promise<MetricsV2ExecutionResult> {
    const blocks = await Promise.all(
      execution.blocks.map((block) => this.enrichBlock(block)),
    );

    return { blocks };
  }

  private async enrichBlock(
    block: MetricsV2ExecutionBlock,
  ): Promise<MetricsV2ExecutionBlock> {
    if (block.request.plan.businessConcept !== 'vessel_position') {
      return block;
    }

    const coordinates = this.extractCoordinates(block.items);
    if (!coordinates) {
      return block;
    }

    const humanLocation = await this.reverseGeocoder.reverseGeocode(coordinates);

    return {
      ...block,
      derivedAnswer: {
        kind: 'vessel_position',
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        humanLocation,
      },
    };
  }

  private extractCoordinates(items: MetricsV2ValueItem[]): {
    latitude: number;
    longitude: number;
  } | null {
    let latitude: number | null = null;
    let longitude: number | null = null;

    for (const item of items) {
      const numericValue =
        typeof item.value === 'number' && Number.isFinite(item.value)
          ? item.value
          : typeof item.value === 'string'
            ? Number(item.value)
            : NaN;

      if (!Number.isFinite(numericValue)) {
        continue;
      }

      const axis = this.inferCoordinateAxis(item);
      if (axis === 'latitude' && latitude == null) {
        latitude = numericValue;
      }
      if (axis === 'longitude' && longitude == null) {
        longitude = numericValue;
      }
    }

    if (latitude == null || longitude == null) {
      return null;
    }

    return { latitude, longitude };
  }

  private inferCoordinateAxis(
    item: MetricsV2ValueItem,
  ): 'latitude' | 'longitude' | null {
    const haystack = [
      item.key,
      item.label,
      item.field ?? '',
      item.description ?? '',
    ]
      .join('\n')
      .toLowerCase();

    if (/\b(latitude|lat)\b/.test(haystack)) {
      return 'latitude';
    }

    if (/\b(longitude|lon|lng)\b/.test(haystack)) {
      return 'longitude';
    }

    return null;
  }
}
