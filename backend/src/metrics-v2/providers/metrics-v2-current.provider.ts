import { Injectable } from '@nestjs/common';
import {
  MetricsV2ExecutionBlock,
  MetricsV2ResolvedRequest,
  MetricsV2ValueItem,
} from '../metrics-v2.types';

@Injectable()
export class MetricsV2CurrentProvider {
  async fetch(
    request: MetricsV2ResolvedRequest,
  ): Promise<MetricsV2ExecutionBlock> {
    const items: MetricsV2ValueItem[] = request.entries.map((entry) => ({
      key: entry.key,
      label: entry.label,
      value: entry.latestValue,
      unit: entry.unit,
      timestamp: entry.valueUpdatedAt?.toISOString() ?? null,
      groupMemberKey: entry.groupMemberKey,
      field: entry.field,
      description: entry.description,
    }));

    return {
      request,
      items,
      totalValue: this.computeTotal(request, items),
      unit: this.pickCommonUnit(items),
      summaryLabel: this.buildSummaryLabel(request),
      timeLabel: 'current',
    };
  }

  private computeTotal(
    request: MetricsV2ResolvedRequest,
    items: MetricsV2ValueItem[],
  ): number | null {
    if (
      request.plan.presentation !== 'breakdown_with_total' &&
      request.plan.presentation !== 'total_only' &&
      request.plan.aggregation !== 'sum'
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

  private buildSummaryLabel(request: MetricsV2ResolvedRequest): string {
    if (request.plan.shape === 'group') {
      return request.plan.concept || 'Grouped current metrics';
    }

    return request.entries[0]?.label ?? request.plan.concept;
  }
}
