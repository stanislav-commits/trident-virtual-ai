import { Injectable } from '@nestjs/common';
import { AssistantCanonicalCopyService } from '../assistant-text/assistant-canonical-copy.service';
import { AssistantFallbackWriterService } from '../assistant-text/assistant-fallback-writer.service';
import { AssistantTextLocalizerService } from '../assistant-text/assistant-text-localizer.service';
import { MetricsV2CatalogService } from './catalog/metrics-v2-catalog.service';
import { MetricsV2MetricResolverService } from './catalog/metrics-v2-metric-resolver.service';
import { MetricsV2ClarificationService } from './execution/metrics-v2-clarification.service';
import { MetricsV2QueryExecutorService } from './execution/metrics-v2-query-executor.service';
import { MetricsV2QueryPlannerService } from './planning/metrics-v2-query-planner.service';
import { MetricsV2RequestClassifierService } from './planning/metrics-v2-request-classifier.service';
import { MetricsV2ResponseComposerService } from './responders/metrics-v2-response-composer.service';
import { MetricsV2ResponderResult } from './metrics-v2.types';

@Injectable()
export class MetricsV2ResponderService {
  constructor(
    private readonly requestClassifier: MetricsV2RequestClassifierService,
    private readonly queryPlanner: MetricsV2QueryPlannerService,
    private readonly catalogService: MetricsV2CatalogService,
    private readonly metricResolver: MetricsV2MetricResolverService,
    private readonly copy: AssistantCanonicalCopyService,
    private readonly localizer: AssistantTextLocalizerService,
    private readonly fallbackWriter: AssistantFallbackWriterService,
    private readonly clarificationService: MetricsV2ClarificationService,
    private readonly queryExecutor: MetricsV2QueryExecutorService,
    private readonly responseComposer: MetricsV2ResponseComposerService,
  ) {}

  async respond(params: {
    shipId?: string;
    shipName?: string;
    shipOrganizationName?: string;
    userQuery: string;
    language?: string | null;
    recentMessages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  }): Promise<MetricsV2ResponderResult> {
    const classification = await this.requestClassifier.classify({
      userQuery: params.userQuery,
      recentMessages: params.recentMessages,
    });
    const plan = await this.queryPlanner.plan({
      userQuery: params.userQuery,
      recentMessages: params.recentMessages,
    });

    if (classification.kind !== 'metrics_request' && plan.requests.length === 0) {
      return {
        handled: false,
        classification,
        plan,
        reason: classification.reason,
      };
    }

    if (!params.shipId) {
      return {
        handled: true,
        classification,
        content: await this.localizer.localize({
          language: params.language,
          canonicalText: this.copy.t('metrics.missing_ship'),
          userQuery: params.userQuery,
        }),
        sourceOfTruth: 'current_metrics',
        usedCurrentMetrics: false,
        usedHistoricalMetrics: false,
      };
    }

    if (plan.requests.length === 0) {
      return {
        handled: true,
        classification,
        plan,
        content: await this.buildEmptyPlanResponse({
          language: params.language,
          userQuery: params.userQuery,
        }),
        sourceOfTruth: 'current_metrics',
        usedCurrentMetrics: false,
        usedHistoricalMetrics: false,
      };
    }

    const catalog = await this.catalogService.loadShipCatalog(params.shipId);
    const resolvedPlan = this.metricResolver.resolve({
      planRequests: plan.requests,
      catalog,
    });
    const clarification = await this.clarificationService.extractClarification(
      resolvedPlan,
      params.language,
    );

    if (clarification) {
      const pendingClarification = this.buildPendingClarification({
        resolvedPlan,
        question: clarification.question,
        language: params.language,
        originalUserQuery: params.userQuery,
      });

      return {
        handled: true,
        classification,
        plan,
        debug: resolvedPlan.debug,
        content: clarification.question,
        sourceOfTruth: 'current_metrics',
        usedCurrentMetrics: false,
        usedHistoricalMetrics: false,
        ...(pendingClarification
          ? { pendingClarification }
          : {}),
      };
    }

    const execution = await this.queryExecutor.execute({
      plan: resolvedPlan,
      organizationName: params.shipOrganizationName,
    });
    const composed = this.responseComposer.compose({
      execution,
    });

    return {
      handled: true,
      classification,
      plan,
      debug: resolvedPlan.debug,
      content: await this.localizer.localize({
        language: params.language,
        canonicalText: composed.content,
        userQuery: params.userQuery,
      }),
      sourceOfTruth: composed.sourceOfTruth,
      usedCurrentMetrics: composed.usedCurrentMetrics,
      usedHistoricalMetrics: composed.usedHistoricalMetrics,
    };
  }

  private buildEmptyPlanResponse(params: {
    language?: string | null;
    userQuery: string;
  }): Promise<string> {
    return this.fallbackWriter.write({
      language: params.language,
      key: 'fallback.metrics.empty_plan',
      userQuery: params.userQuery,
    });
  }

  private buildPendingClarification(params: {
    resolvedPlan: Awaited<ReturnType<MetricsV2MetricResolverService['resolve']>>;
    question: string;
    language?: string | null;
    originalUserQuery: string;
  }) {
    const targetRequest = params.resolvedPlan.requests.find(
      (request) =>
        request.clarificationKind === 'ambiguous_metrics' &&
        request.clarificationOptions?.length,
    );

    if (!targetRequest) {
      return undefined;
    }

    return {
      id: `metrics_clarification_${Date.now()}`,
      domain: 'metrics_v2' as const,
      kind: targetRequest.clarificationKind ?? 'ambiguous_metrics',
      language: params.language ?? null,
      question: params.question,
      originalUserQuery: params.originalUserQuery,
      createdAtIso: new Date().toISOString(),
      requestId: targetRequest.plan.requestId,
      requestPlan: targetRequest.plan as unknown as Record<string, unknown>,
      options: targetRequest.entries.map((entry, index) => ({
        id: `${targetRequest.plan.requestId}:${index + 1}`,
        label: entry.label,
        metricKey: entry.key,
        businessConcept: entry.businessConcept,
        measurementKind: entry.measurementKind,
        source: targetRequest.plan.source,
      })),
    };
  }
}
