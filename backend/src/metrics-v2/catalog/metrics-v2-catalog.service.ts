import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MetricsV2AssetType,
  MetricsV2CatalogEntry,
  MetricsV2FluidType,
  MetricsV2MeasurementKind,
} from '../metrics-v2.types';
import {
  inferMetricsV2AggregationCompatibility,
  inferMetricsV2BusinessConcept,
  inferMetricsV2GroupFamily,
  inferMetricsV2MeasuredSubject,
  inferMetricsV2MotionReference,
  inferMetricsV2OperationalMeaning,
  inferMetricsV2SignalRole,
  inferMetricsV2SystemDomain,
  inferMetricsV2UnitKind,
} from '../semantic';

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
    const baseSearchText = [
      label,
      description ?? '',
      config.metric?.bucket ?? '',
      config.metric?.field ?? '',
    ]
      .join('\n')
      .toLowerCase();

    const measurementKind = this.inferMeasurementKind(baseSearchText, unit);
    const fluidType = this.inferFluidType(baseSearchText);
    const assetType = this.inferAssetType(baseSearchText);
    const systemDomain = inferMetricsV2SystemDomain(baseSearchText);
    const measuredSubject = inferMetricsV2MeasuredSubject({
      searchText: baseSearchText,
      measurementKind,
      systemDomain,
      fluidType,
      assetType,
    });
    const unitKind = inferMetricsV2UnitKind({
      searchText: baseSearchText,
      unit,
    });
    const businessConcept = inferMetricsV2BusinessConcept({
      searchText: baseSearchText,
      measurementKind,
      systemDomain,
      measuredSubject,
      fluidType,
      assetType,
      unitKind,
    });
    const signalRole = inferMetricsV2SignalRole({
      businessConcept,
      measurementKind,
      systemDomain,
      measuredSubject,
    });
    const motionReference = inferMetricsV2MotionReference({
      searchText: baseSearchText,
      businessConcept,
      measurementKind,
      systemDomain,
      measuredSubject,
      signalRole,
    });
    const groupFamily = inferMetricsV2GroupFamily(businessConcept);
    const operationalMeaning = inferMetricsV2OperationalMeaning({
      businessConcept,
      systemDomain,
      measuredSubject,
      signalRole,
      motionReference,
      fluidType,
      assetType,
      measurementKind,
      label,
    });
    const semanticSummary = [
      `business concept: ${businessConcept}`,
      systemDomain ? `system domain: ${systemDomain}` : null,
      measuredSubject ? `measured subject: ${measuredSubject}` : null,
      signalRole ? `signal role: ${signalRole}` : null,
      motionReference ? `motion reference: ${motionReference}` : null,
      fluidType ? `fluid type: ${fluidType}` : null,
      assetType ? `asset type: ${assetType}` : null,
      groupFamily ? `group family: ${groupFamily}` : null,
      unitKind ? `unit kind: ${unitKind}` : null,
      `measurement kind: ${measurementKind}`,
      operationalMeaning,
    ]
      .filter(Boolean)
      .join('. ');
    const searchText = [baseSearchText, semanticSummary].join('\n').toLowerCase();
    const groupMemberKey = this.inferGroupMemberKey(config.metricKey, label);
    const inferredGroupKey =
      fluidType && assetType && fluidType !== 'unknown' && assetType !== 'unknown'
        ? `${fluidType}_${assetType}`
        : null;

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
      operationalMeaning,
      semanticSummary,
      businessConcept,
      measurementKind,
      systemDomain,
      measuredSubject,
      signalRole,
      motionReference,
      unitKind,
      fluidType,
      assetType,
      groupFamily,
      aggregationCompatibility: inferMetricsV2AggregationCompatibility({
        businessConcept,
        measurementKind,
        unitKind,
      }),
      semanticConfidence: businessConcept === 'unknown' ? 0.35 : 0.82,
      inferredGroupKey,
      groupMemberKey,
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

  private inferMeasurementKind(
    searchText: string,
    unit?: string | null,
  ): MetricsV2MeasurementKind {
    if (/\b(time\s*to\s*go|t\.?t\.?g\.?|eta)\b/.test(searchText)) {
      return 'runtime';
    }
    if (/\b(rate\s*of\s*turn|rateofturn)\b/.test(searchText)) {
      return 'unknown';
    }
    if (/\b(trip\.log|trip log|distance|nautical miles?)\b/.test(searchText)) {
      return 'quantity';
    }
    if (
      /\b(speed\s*over\s*ground|speedoverground|speed\s*through\s*water|speedthroughwater|velocity\s*made\s*good|velocitymadegood|sog|stw|vmg)\b/.test(
        searchText,
      )
    ) {
      return 'speed';
    }
    if (/\b(latitude|longitude|position|coordinates?|gps)\b/.test(searchText)) {
      return 'location';
    }
    if (/\b(speed|sog|stw|vmg|knots?)\b/.test(searchText)) {
      return 'speed';
    }
    if (/\b(runtime|running hours|hour meter|hours run)\b/.test(searchText)) {
      return 'runtime';
    }
    if (/\b(voltage|volt)\b/.test(searchText)) {
      return 'voltage';
    }
    if (/\b(amp|amps|amperage|ampere)\b/.test(searchText)) {
      return 'current';
    }
    if (/\b(power|kw|kilowatt|watt)\b/.test(searchText)) {
      return 'power';
    }
    if (/\b(active energy|energy delivered|energy received|kwh|wh|mwh)\b/.test(searchText)) {
      return 'energy';
    }
    if (/\b(pressure|bar|psi)\b/.test(searchText)) {
      return 'pressure';
    }
    if (/\b(temperature|temp|celsius|fahrenheit|degrees?)\b/.test(searchText)) {
      return 'temperature';
    }
    if (/\b(level|volume|liters?|litres?|quantity|remaining|onboard)\b/.test(searchText)) {
      return /\bvolume\b/.test(searchText) ? 'volume' : 'level';
    }
    if (/\b(status|state|alarm)\b/.test(searchText)) {
      return 'status';
    }

    return 'unknown';
  }

  private inferFluidType(searchText: string): MetricsV2FluidType {
    if (/\b(def|urea)\b/.test(searchText)) return 'def';
    if (/\bfuel\b/.test(searchText)) return 'fuel';
    if (/\boil\b/.test(searchText)) return 'oil';
    if (/\bcoolant\b/.test(searchText)) return 'coolant';
    if (/\bwater\b/.test(searchText)) return 'water';
    return null;
  }

  private inferAssetType(searchText: string): MetricsV2AssetType {
    if (/\bpump\b/.test(searchText)) return 'pump';
    if (
      /\b(storage tank|fuel tank|water tank|oil tank|urea tank|def tank|tank level|tank volume|tank quantity)\b/.test(
        searchText,
      )
    ) {
      return 'storage_tank';
    }
    if (/\bgenerator|genset\b/.test(searchText)) return 'generator';
    if (/\bengine\b/.test(searchText)) return 'engine';
    if (/\bbattery\b/.test(searchText)) return 'battery';
    if (/\bcharger\b/.test(searchText)) return 'charger';
    if (
      /\b(nmea|gps|gnss|navigation|heading|course|sog|stw|speed\s*over\s*ground|speedoverground|speed\s*through\s*water|speedthroughwater|latitude|longitude|position|coordinates?)\b/.test(
        searchText,
      )
    ) {
      return 'navigation';
    }
    if (/\btank\b/.test(searchText)) return 'storage_tank';
    return null;
  }

  private inferGroupMemberKey(
    metricKey: string,
    label: string,
  ): string | null {
    const combined = `${metricKey} ${label}`;
    const tankMatch = combined.match(/\b(\d+[ps]|[ps]\d+)\b/i);
    if (tankMatch) {
      return tankMatch[1].toUpperCase();
    }

    const plainNumberMatch = combined.match(/\btank[_\s-]?(\d+)\b/i);
    if (plainNumberMatch) {
      return plainNumberMatch[1];
    }

    return null;
  }
}
