import { Injectable } from '@nestjs/common';
import {
  MetricsV2ExecutionResult,
  MetricsV2ResolvedPlan,
} from '../metrics-v2.types';
import { MetricsV2CurrentProvider } from '../providers/metrics-v2-current.provider';
import { MetricsV2HistoricalProvider } from '../providers/metrics-v2-historical.provider';
import { MetricsV2DerivedAnswerService } from './metrics-v2-derived-answer.service';

@Injectable()
export class MetricsV2QueryExecutorService {
  constructor(
    private readonly currentProvider: MetricsV2CurrentProvider,
    private readonly historicalProvider: MetricsV2HistoricalProvider,
    private readonly derivedAnswerService: MetricsV2DerivedAnswerService,
  ) {}

  async execute(params: {
    plan: MetricsV2ResolvedPlan;
    organizationName?: string;
  }): Promise<MetricsV2ExecutionResult> {
    const blocks = await Promise.all(
      params.plan.requests
        .filter((request) => !request.clarificationQuestion && request.entries.length > 0)
        .map(async (request) => {
          if (request.plan.source === 'current') {
            return this.currentProvider.fetch(request);
          }

          if (!params.organizationName?.trim()) {
            return {
              request,
              items: request.entries.map((entry) => ({
                key: entry.key,
                label: entry.label,
                value: null,
                unit: entry.unit,
                timestamp: null,
                groupMemberKey: entry.groupMemberKey,
              })),
              summaryLabel: request.plan.concept,
              timeLabel: 'historical',
            };
          }

          return this.historicalProvider.fetch({
            request,
            organizationName: params.organizationName.trim(),
          });
        }),
    );

    return this.derivedAnswerService.enrichExecution({ blocks });
  }
}
