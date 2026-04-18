import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MetricsV2CatalogEntry } from '../metrics-v2.types';

@Injectable()
export class MetricsV2CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async loadShipCatalog(shipId: string): Promise<MetricsV2CatalogEntry[]> {
    const configs = await this.prisma.shipMetricsConfig.findMany({
      where: { shipId, isActive: true },
      select: {
        metricKey: true,
        latestValue: true,
        valueUpdatedAt: true,
        metric: {
          select: {
            label: true,
            description: true,
            unit: true,
            bucket: true,
            measurement: true,
            field: true,
            dataType: true,
          },
        },
      },
    });

    return configs.map((config) => this.toCatalogEntry(config));
  }

  private toCatalogEntry(config: {
    metricKey: string;
    latestValue: unknown;
    valueUpdatedAt: Date | null;
    metric: {
      label: string;
      description: string | null;
      unit: string | null;
      bucket: string | null;
      measurement: string | null;
      field: string | null;
      dataType: string | null;
    } | null;
  }): MetricsV2CatalogEntry {
    const rawLabel =
      config.metric?.measurement && config.metric?.field
        ? `${config.metric.measurement}.${config.metric.field}`
        : null;
    const storedLabel = config.metric?.label ?? null;
    const label =
      storedLabel && storedLabel !== rawLabel
        ? storedLabel
        : config.metric?.field ?? storedLabel ?? config.metricKey;
    const description = config.metric?.description ?? null;
    const unit = config.metric?.unit ?? null;
    const searchText = [
      config.metricKey,
      label,
      description ?? '',
      config.metric?.bucket ?? '',
      config.metric?.field ?? '',
      unit ?? '',
    ]
      .join('\n')
      .toLowerCase();
    const semanticSummary = 'No inferred semantic metadata is attached at runtime.';

    return {
      key: config.metricKey,
      label,
      description,
      unit,
      dataType: config.metric?.dataType ?? null,
      bucket: config.metric?.bucket ?? null,
      measurement: config.metric?.measurement ?? null,
      field: config.metric?.field ?? null,
      latestValue: this.toPrimitiveValue(config.latestValue),
      valueUpdatedAt: config.valueUpdatedAt,
      searchText,
      operationalMeaning: description ?? label,
      semanticSummary,
      businessConcept: 'unknown',
      measurementKind: 'unknown',
      systemDomain: null,
      measuredSubject: null,
      signalRole: null,
      motionReference: null,
      unitKind: null,
      fluidType: null,
      assetType: null,
      groupFamily: null,
      aggregationCompatibility: ['latest_point'],
      semanticConfidence: 0,
      inferredGroupKey: null,
      groupMemberKey: null,
    };
  }

  private toPrimitiveValue(
    value: unknown,
  ): string | number | boolean | null {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }

    return null;
  }
}
