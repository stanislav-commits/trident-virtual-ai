import { Injectable } from '@nestjs/common';
import { AssistantCanonicalCopyService } from '../../assistant-text/assistant-canonical-copy.service';
import {
  MetricsV2ComposedResponse,
  MetricsV2ExecutionBlock,
  MetricsV2ExecutionResult,
  MetricsV2MetricSource,
} from '../metrics-v2.types';

@Injectable()
export class MetricsV2ResponseComposerService {
  constructor(private readonly copy: AssistantCanonicalCopyService) {}

  compose(params: {
    execution: MetricsV2ExecutionResult;
  }): MetricsV2ComposedResponse {
    const usedSources = new Set<MetricsV2MetricSource>(
      params.execution.blocks.map((block) => block.request.plan.source),
    );

    const content = params.execution.blocks
      .map((block) => this.composeBlock(block))
      .join('\n\n')
      .trim();

    return {
      content,
      sourceOfTruth:
        usedSources.size > 1
          ? 'mixed_metrics'
          : usedSources.has('historical')
            ? 'historical_metrics'
            : 'current_metrics',
      usedCurrentMetrics: usedSources.has('current'),
      usedHistoricalMetrics: usedSources.has('historical'),
    };
  }

  private composeBlock(block: MetricsV2ExecutionBlock): string {
    if (block.derivedAnswer?.kind === 'vessel_position') {
      return this.composeVesselPositionBlock(block);
    }

    const heading = this.composeHeading(block);
    const lines: string[] = [];

    if (block.request.plan.presentation === 'breakdown_with_total' && block.totalValue != null) {
      lines.push(
        this.composeTotalLine(
          block,
          block.totalValue,
          block.unit ?? undefined,
        ),
      );
    }

    if (
      block.request.plan.presentation === 'breakdown' ||
      block.request.plan.presentation === 'breakdown_with_total' ||
      (block.request.plan.shape === 'group' && block.items.length > 1)
    ) {
      for (const item of block.items) {
        lines.push(
          `- ${this.formatItemLabel(item)}: ${this.formatValue(item.value)}${item.unit ? ` ${item.unit}` : ''}`,
        );
      }
    } else if (block.items[0]) {
      const item = block.items[0];
      lines.push(
        `${item.label}: ${this.formatValue(item.value)}${item.unit ? ` ${item.unit}` : ''}`,
      );
    }

    if (block.timeLabel && block.timeLabel !== 'current') {
      lines.push(this.composeTimeLine(block.timeLabel));
    }

    return [heading, ...lines].filter(Boolean).join('\n');
  }

  private composeVesselPositionBlock(block: MetricsV2ExecutionBlock): string {
    const derived = block.derivedAnswer;
    if (!derived || derived.kind !== 'vessel_position') {
      return '';
    }

    const heading = this.composeVesselPositionHeading();
    const coordinates = `${this.formatCoordinate(derived.latitude)}, ${this.formatCoordinate(derived.longitude)}`;
    const lines: string[] = [];

    if (derived.humanLocation) {
      lines.push(
        `${this.copy.t('metrics.location_label')}: ${derived.humanLocation}`,
      );
    }
    lines.push(
      `${this.copy.t('metrics.coordinates_label')}: ${coordinates}`,
    );

    if (block.timeLabel && block.timeLabel !== 'current') {
      lines.push(this.composeTimeLine(block.timeLabel));
    }

    return [heading, ...lines].filter(Boolean).join('\n');
  }

  private composeVesselPositionHeading(): string {
    return this.copy.t('metrics.vessel_position_heading');
  }

  private formatItemLabel(item: MetricsV2ExecutionBlock['items'][number]): string {
    const label = item.label.trim();
    const groupMemberKey = item.groupMemberKey?.trim();

    if (!groupMemberKey) {
      return label;
    }

    const normalizedLabel = label.toLowerCase();
    const normalizedGroupMemberKey = groupMemberKey.toLowerCase();
    const escapedGroupMemberKey = normalizedGroupMemberKey.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
    const duplicateTokenPattern = new RegExp(
      `(^|[^a-z0-9])${escapedGroupMemberKey}([^a-z0-9]|$)`,
      'i',
    );

    if (duplicateTokenPattern.test(normalizedLabel)) {
      return label;
    }

    return `${groupMemberKey}: ${label}`;
  }

  private composeHeading(block: MetricsV2ExecutionBlock): string {
    if (block.request.plan.source === 'historical') {
      return this.copy.t('metrics.historical_heading');
    }

    return this.copy.t('metrics.current_heading');
  }

  private composeTotalLine(
    block: MetricsV2ExecutionBlock,
    totalValue: number,
    unit?: string,
  ): string {
    const renderedValue = `${this.formatValue(totalValue)}${unit ? ` ${unit}` : ''}`;
    return `${this.copy.t('metrics.total_label')}: ${renderedValue}`;
  }

  private composeTimeLine(timeLabel: string): string {
    return `${this.copy.t('metrics.period_label')}: ${timeLabel}`;
  }

  private formatValue(value: string | number | boolean | null): string {
    if (typeof value === 'number') {
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }

    if (typeof value === 'boolean') {
      return value ? 'true' : 'false';
    }

    if (value == null) {
      return 'n/a';
    }

    return value;
  }

  private formatCoordinate(value: number): string {
    return value.toFixed(6);
  }
}
