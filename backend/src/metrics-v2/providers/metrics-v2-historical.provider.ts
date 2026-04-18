import { Injectable } from '@nestjs/common';
import {
  InfluxHistoricalQueryRange,
  InfluxMetricValue,
  InfluxdbService,
} from '../../influxdb/influxdb.service';
import {
  MetricsV2ExecutionBlock,
  MetricsV2ResolvedRequest,
  MetricsV2TimeRange,
  MetricsV2ValueItem,
} from '../metrics-v2.types';

@Injectable()
export class MetricsV2HistoricalProvider {
  constructor(private readonly influxdb: InfluxdbService) {}

  async fetch(params: {
    request: MetricsV2ResolvedRequest;
    organizationName: string;
  }): Promise<MetricsV2ExecutionBlock> {
    const { request, organizationName } = params;
    const keys = request.entries.map((entry) => entry.key);

    const rows = await this.queryRows({
      keys,
      request,
      organizationName,
    });
    const rowsByKey = new Map<string, InfluxMetricValue>(
      rows.map((row) => [row.key, row]),
    );

    const items: MetricsV2ValueItem[] = request.entries.map((entry) => {
      const row = rowsByKey.get(entry.key);
      return {
        key: entry.key,
        label: entry.label,
        value: row?.value ?? null,
        unit: entry.unit,
        timestamp: row?.time ?? null,
        groupMemberKey: entry.groupMemberKey,
        field: entry.field,
        description: entry.description,
      };
    });

    return {
      request,
      items,
      totalValue: this.computeTotal(request, items),
      unit: this.pickCommonUnit(items),
      summaryLabel: request.plan.concept || request.entries[0]?.label,
      timeLabel: this.describeTimeRange(request.plan.timeRange),
    };
  }

  private async queryRows(params: {
    keys: string[];
    request: MetricsV2ResolvedRequest;
    organizationName: string;
  }): Promise<InfluxMetricValue[]> {
    const { keys, request, organizationName } = params;

    if (request.plan.timeRange.kind === 'point_in_time') {
      return this.influxdb.queryHistoricalNearestValues(
        keys,
        new Date(request.plan.timeRange.pointIso),
        organizationName,
      );
    }

    const range = this.toInfluxRange(request.plan.timeRange);

    if (request.plan.aggregation === 'avg') {
      return this.influxdb.queryHistoricalAggregate(
        keys,
        range,
        'mean',
        organizationName,
      );
    }

    if (
      request.plan.aggregation === 'sum' ||
      request.plan.aggregation === 'min' ||
      request.plan.aggregation === 'max'
    ) {
      return this.influxdb.queryHistoricalAggregate(
        keys,
        range,
        request.plan.aggregation,
        organizationName,
      );
    }

    if (request.plan.aggregation === 'delta') {
      const { first, last } = await this.influxdb.queryHistoricalFirstLast(
        keys,
        range,
        organizationName,
      );
      const firstByKey = new Map(first.map((row) => [row.key, row]));
      const lastByKey = new Map(last.map((row) => [row.key, row]));

      return keys.map((key) => {
        const firstRow = firstByKey.get(key);
        const lastRow = lastByKey.get(key);
        const firstValue =
          typeof firstRow?.value === 'number' ? firstRow.value : null;
        const lastValue = typeof lastRow?.value === 'number' ? lastRow.value : null;

        return {
          key,
          bucket: lastRow?.bucket ?? firstRow?.bucket ?? '',
          measurement: lastRow?.measurement ?? firstRow?.measurement ?? '',
          field: lastRow?.field ?? firstRow?.field ?? '',
          value:
            firstValue != null && lastValue != null ? lastValue - firstValue : null,
          time: lastRow?.time ?? firstRow?.time ?? new Date().toISOString(),
        };
      });
    }

    if (request.plan.aggregation === 'latest') {
      const { last } = await this.influxdb.queryHistoricalFirstLast(
        keys,
        range,
        organizationName,
      );
      return last;
    }

    return this.influxdb.queryHistoricalSeries(keys, range, organizationName, {
      windowEvery: '1h',
    });
  }

  private toInfluxRange(timeRange: MetricsV2TimeRange): InfluxHistoricalQueryRange {
    if (timeRange.kind === 'absolute') {
      return {
        start: new Date(timeRange.startIso),
        stop: new Date(timeRange.endIso),
      };
    }

    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    if (timeRange.kind === 'relative') {
      switch (timeRange.preset) {
        case 'today':
          return { start: startOfToday, stop: now };
        case 'yesterday': {
          const start = new Date(startOfToday);
          start.setDate(start.getDate() - 1);
          return { start, stop: startOfToday };
        }
        case 'last_24_hours':
          return {
            start: new Date(now.getTime() - 24 * 60 * 60 * 1000),
            stop: now,
          };
        case 'last_7_days':
          return {
            start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
            stop: now,
          };
        case 'this_week': {
          const start = new Date(startOfToday);
          const day = start.getDay();
          const diff = day === 0 ? 6 : day - 1;
          start.setDate(start.getDate() - diff);
          return { start, stop: now };
        }
        case 'this_month': {
          const start = new Date(now.getFullYear(), now.getMonth(), 1);
          return { start, stop: now };
        }
      }
    }

    return {
      start: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      stop: now,
    };
  }

  private describeTimeRange(timeRange: MetricsV2TimeRange): string {
    if (timeRange.kind === 'relative') {
      return timeRange.label ?? timeRange.preset.replace(/_/g, ' ');
    }

    if (timeRange.kind === 'point_in_time') {
      return timeRange.label ?? timeRange.pointIso;
    }

    if (timeRange.kind === 'absolute') {
      return timeRange.label ?? `${timeRange.startIso} to ${timeRange.endIso}`;
    }

    return 'historical';
  }

  private computeTotal(
    request: MetricsV2ResolvedRequest,
    items: MetricsV2ValueItem[],
  ): number | null {
    if (
      request.plan.presentation !== 'breakdown_with_total' &&
      request.plan.presentation !== 'total_only' &&
      request.plan.aggregation !== 'sum' &&
      request.plan.businessConcept !== 'fuel_onboard_inventory' &&
      request.plan.businessConcept !== 'oil_onboard_inventory' &&
      request.plan.businessConcept !== 'water_onboard_inventory' &&
      request.plan.businessConcept !== 'def_onboard_inventory'
    ) {
      return null;
    }

    if (!this.pickCommonUnit(items)) {
      return null;
    }

    const numericValues = items
      .map((item) =>
        typeof item.value === 'number' && Number.isFinite(item.value)
          ? item.value
          : null,
      )
      .filter((value): value is number => value !== null);

    if (numericValues.length === 0 || numericValues.length !== items.length) {
      return null;
    }

    return numericValues.reduce((sum, value) => sum + value, 0);
  }

  private pickCommonUnit(items: MetricsV2ValueItem[]): string | null {
    const normalizedUnits = [...new Set(items.map((item) => item.unit ?? null))];
    return normalizedUnits.length === 1 ? normalizedUnits[0] : null;
  }
}
