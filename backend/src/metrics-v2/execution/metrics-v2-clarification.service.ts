import { Injectable } from '@nestjs/common';
import { AssistantFallbackWriterService } from '../../assistant-text/assistant-fallback-writer.service';
import { MetricsV2ResolvedPlan } from '../metrics-v2.types';

@Injectable()
export class MetricsV2ClarificationService {
  constructor(
    private readonly fallbackWriter: AssistantFallbackWriterService,
  ) {}

  async extractClarification(
    plan: MetricsV2ResolvedPlan,
    language?: string | null,
  ): Promise<{
    question: string;
    options?: string[];
  } | null> {
    for (const request of plan.requests) {
      if (!request.clarificationQuestion && !request.clarificationKind) {
        continue;
      }

      return {
        question: await this.buildQuestion({
          clarificationKind: request.clarificationKind,
          clarificationQuestion: request.clarificationQuestion,
          clarificationOptions: request.clarificationOptions,
          language,
          userQuery:
            request.plan.metricHints?.[0] ??
            request.plan.entityHints?.[0] ??
            request.plan.businessConcept,
        }),
        ...(request.clarificationOptions?.length
          ? { options: request.clarificationOptions }
          : {}),
      };
    }

    return null;
  }

  private buildQuestion(params: {
    clarificationKind: MetricsV2ResolvedPlan['requests'][number]['clarificationKind'];
    clarificationQuestion?: string | null;
    clarificationOptions?: string[];
    language?: string | null;
    userQuery: string;
  }): Promise<string> {
    const key =
      params.clarificationKind === 'group_not_confident'
        ? 'fallback.metrics.group_not_confident'
        : params.clarificationKind === 'exact_metric_not_found'
          ? 'fallback.metrics.exact_metric_not_found'
          : params.clarificationKind === 'ambiguous_metrics'
            ? 'fallback.metrics.ambiguous_metrics'
            : 'fallback.metrics.generic';

    return this.fallbackWriter.write({
      language: params.language,
      key,
      userQuery: params.userQuery,
      context: [
        params.clarificationQuestion
          ? `Planner draft question: ${params.clarificationQuestion}`
          : '',
        params.clarificationOptions?.length
          ? `Available options: ${params.clarificationOptions.join(', ')}`
          : '',
      ],
    });
  }
}
