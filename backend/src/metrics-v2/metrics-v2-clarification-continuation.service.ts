import { Injectable } from '@nestjs/common';
import { AssistantCanonicalCopyService } from '../assistant-text/assistant-canonical-copy.service';
import { AssistantTextLocalizerService } from '../assistant-text/assistant-text-localizer.service';
import { PendingClarification } from '../chat-shared/clarification/pending-clarification.types';
import {
  ChatV2ClarificationContinuationDecision,
  ChatV2ClarificationContinuationResult,
} from '../chat-v2/clarification/chat-v2-clarification.types';
import { ChatV2TurnContext } from '../chat-v2/context/chat-v2-turn-context.types';
import { ChatV2TurnClassification } from '../chat-v2/chat-v2.types';
import {
  MetricsV2MetricRequestPlan,
  MetricsV2ResolvedPlan,
  MetricsV2ResolvedRequest,
} from './metrics-v2.types';
import { MetricsV2CatalogService } from './catalog/metrics-v2-catalog.service';
import { MetricsV2QueryExecutorService } from './execution/metrics-v2-query-executor.service';
import { MetricsV2ResponseComposerService } from './responders/metrics-v2-response-composer.service';

@Injectable()
export class MetricsV2ClarificationContinuationService {
  constructor(
    private readonly catalogService: MetricsV2CatalogService,
    private readonly queryExecutor: MetricsV2QueryExecutorService,
    private readonly responseComposer: MetricsV2ResponseComposerService,
    private readonly copy: AssistantCanonicalCopyService,
    private readonly localizer: AssistantTextLocalizerService,
  ) {}

  async handle(params: {
    turnContext: ChatV2TurnContext;
    pendingClarification: PendingClarification;
    decision: ChatV2ClarificationContinuationDecision;
  }): Promise<ChatV2ClarificationContinuationResult> {
    const classification = this.buildContinuationClassification(
      params.pendingClarification.language,
      params.turnContext.userQuery,
      params.decision.reason,
    );

    switch (params.decision.intent) {
      case 'show_options':
      case 'unknown':
        return {
          handled: true,
          draft: {
            content: await this.buildOptionsResponse(params.pendingClarification),
            classification,
            answerRoute: 'metrics_v2',
            usedLlm: false,
            sourceOfTruth: 'current_metrics',
            extraContext: {
              pendingClarification: params.pendingClarification,
              clarificationContinuation: params.decision.intent,
            },
          },
        };
      case 'select_option':
        return this.handleSelectedOption({
          turnContext: params.turnContext,
          pendingClarification: params.pendingClarification,
          selectedOptionId: params.decision.selectedOptionId,
          classification,
        });
      case 'new_request':
      default:
        return { handled: false };
    }
  }

  private async handleSelectedOption(params: {
    turnContext: ChatV2TurnContext;
    pendingClarification: PendingClarification;
    selectedOptionId?: string | null;
    classification: ChatV2TurnClassification;
  }): Promise<ChatV2ClarificationContinuationResult> {
    const option =
      params.pendingClarification.options.find(
        (item) => item.id === params.selectedOptionId,
      ) ?? null;

    if (!option?.metricKey || !params.turnContext.shipId) {
      return {
        handled: true,
        draft: {
          content: await this.buildOptionsResponse(params.pendingClarification),
          classification: params.classification,
          answerRoute: 'metrics_v2',
          usedLlm: false,
          sourceOfTruth: 'current_metrics',
          extraContext: {
            pendingClarification: params.pendingClarification,
            clarificationContinuation: 'invalid_option_selection',
          },
        },
      };
    }

    const catalog = await this.catalogService.loadShipCatalog(params.turnContext.shipId);
    const selectedEntry = catalog.find((entry) => entry.key === option.metricKey);

    if (!selectedEntry) {
      return {
        handled: true,
        draft: {
          content: await this.buildMissingOptionResponse(
            params.pendingClarification,
          ),
          classification: params.classification,
          answerRoute: 'metrics_v2',
          usedLlm: false,
          sourceOfTruth: 'current_metrics',
          extraContext: {
            pendingClarification: params.pendingClarification,
            clarificationContinuation: 'selected_option_missing_in_catalog',
          },
        },
      };
    }

    const requestPlan = this.parseRequestPlan(
      params.pendingClarification.requestPlan,
    );

    if (!requestPlan) {
      return {
        handled: true,
        draft: {
          content: await this.buildMissingOptionResponse(
            params.pendingClarification,
          ),
          classification: params.classification,
          answerRoute: 'metrics_v2',
          usedLlm: false,
          sourceOfTruth: 'current_metrics',
          extraContext: {
            pendingClarification: params.pendingClarification,
            clarificationContinuation: 'request_plan_missing',
          },
        },
      };
    }

    const resolvedPlan: MetricsV2ResolvedPlan = {
      requests: [
        {
          plan: requestPlan,
          entries: [selectedEntry],
        } as MetricsV2ResolvedRequest,
      ],
    };

    const execution = await this.queryExecutor.execute({
      plan: resolvedPlan,
      organizationName: params.turnContext.shipOrganizationName,
    });
    const composed = this.responseComposer.compose({
      execution,
    });

    return {
      handled: true,
      draft: {
        content: await this.localizer.localize({
          language: params.pendingClarification.language,
          canonicalText: composed.content,
          userQuery: params.turnContext.userQuery,
        }),
        classification: params.classification,
        answerRoute: 'metrics_v2',
        usedLlm: false,
        usedCurrentTelemetry: composed.usedCurrentMetrics,
        usedHistoricalTelemetry: composed.usedHistoricalMetrics,
        sourceOfTruth: composed.sourceOfTruth,
        extraContext: {
          clarificationResolved: true,
          clarificationContinuation: 'selected_option',
          resolvedClarificationId: params.pendingClarification.id,
          selectedClarificationOption: option,
        },
      },
    };
  }

  private buildOptionsResponse(
    clarification: PendingClarification,
  ): Promise<string> {
    const lines = clarification.options.map(
      (option, index) => `${index + 1}. ${option.label}`,
    );

    return this.localizer.localize({
      language: clarification.language,
      canonicalText: [
        this.copy.t('metrics.clarification.options_intro'),
        ...lines,
        this.copy.t('metrics.clarification.options_reply'),
      ].join('\n'),
      userQuery: clarification.originalUserQuery,
    });
  }

  private buildMissingOptionResponse(
    clarification: PendingClarification,
  ): Promise<string> {
    return this.localizer.localize({
      language: clarification.language,
      canonicalText: this.copy.t('metrics.clarification.selection_not_matched'),
      userQuery: clarification.originalUserQuery,
    });
  }

  private buildContinuationClassification(
    language: ChatV2TurnClassification['language'],
    userTask: string,
    reason: string,
  ): ChatV2TurnClassification {
    return {
      kind: 'task_request',
      confidence: 0.95,
      language,
      reason,
      userTask,
    };
  }

  private parseRequestPlan(
    requestPlan?: Record<string, unknown>,
  ): MetricsV2MetricRequestPlan | null {
    if (!requestPlan || typeof requestPlan !== 'object') {
      return null;
    }

    return requestPlan as unknown as MetricsV2MetricRequestPlan;
  }
}
