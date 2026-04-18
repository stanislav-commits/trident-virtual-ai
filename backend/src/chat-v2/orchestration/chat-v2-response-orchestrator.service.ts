import { Injectable } from '@nestjs/common';
import {
  ChatV2AssistantDraft,
  ChatV2TurnClassification,
} from '../chat-v2.types';
import { AssistantFallbackWriterService } from '../../assistant-text/assistant-fallback-writer.service';
import { ChatV2ClarificationContinuationService } from '../clarification/chat-v2-clarification-continuation.service';
import { ChatV2TurnContextService } from '../context/chat-v2-turn-context.service';
import { ChatV2GeneralWebResponderService } from '../responders/chat-v2-general-web-responder.service';
import { ChatV2ChatHistoryResponderService } from '../responders/chat-v2-chat-history-responder.service';
import { ChatV2ChatHistorySummaryResponderService } from '../responders/chat-v2-chat-history-summary-responder.service';
import { ChatV2SmallTalkResponderService } from '../responders/chat-v2-small-talk-responder.service';
import { ChatV2UnsupportedShipTaskResponderService } from '../responders/chat-v2-unsupported-ship-task-responder.service';
import { ChatV2TaskRouterService } from '../routing/chat-v2-task-router.service';
import { MetricsV2ResponderService } from '../../metrics-v2/metrics-v2-responder.service';
import { ChatV2TurnClassifierService } from '../intake/chat-v2-turn-classifier.service';

@Injectable()
export class ChatV2ResponseOrchestratorService {
  constructor(
    private readonly turnContextService: ChatV2TurnContextService,
    private readonly clarificationContinuation: ChatV2ClarificationContinuationService,
    private readonly turnClassifier: ChatV2TurnClassifierService,
    private readonly fallbackWriter: AssistantFallbackWriterService,
    private readonly taskRouter: ChatV2TaskRouterService,
    private readonly smallTalkResponder: ChatV2SmallTalkResponderService,
    private readonly chatHistoryResponder: ChatV2ChatHistoryResponderService,
    private readonly chatHistorySummaryResponder: ChatV2ChatHistorySummaryResponderService,
    private readonly generalWebResponder: ChatV2GeneralWebResponderService,
    private readonly unsupportedShipTaskResponder: ChatV2UnsupportedShipTaskResponderService,
    private readonly metricsV2Responder: MetricsV2ResponderService,
  ) {}

  async generate(params: {
    sessionId: string;
    userQuery: string;
  }): Promise<ChatV2AssistantDraft> {
    const turnContext = await this.turnContextService.buildTurnContext(params);
    const clarificationContinuation = await this.clarificationContinuation.tryHandle({
      turnContext,
    });
    if (clarificationContinuation?.handled && clarificationContinuation.draft) {
      return clarificationContinuation.draft;
    }

    const classification = await this.turnClassifier.classify(turnContext.userQuery);

    if (classification.kind === 'small_talk') {
      return this.handleSmallTalk(turnContext, classification);
    }

    return this.handleTaskRequest(turnContext, classification);
  }

  private async handleSmallTalk(
    turnContext: Awaited<
      ReturnType<ChatV2TurnContextService['buildTurnContext']>
    >,
    classification: ChatV2TurnClassification,
  ): Promise<ChatV2AssistantDraft> {
    const response = await this.smallTalkResponder.respond({
      turnContext,
      classification,
    });

    return {
      content: response.content,
      answerRoute: 'small_talk',
      classification,
      usedLlm: true,
      usedChatHistory: turnContext.previousMessages.length > 0,
      sourceOfTruth: 'small_talk',
      extraContext: {
        historyMessageCount: turnContext.messageHistory.length,
        ...(response.responseId ? { llmResponseId: response.responseId } : {}),
      },
    };
  }

  private async handleTaskRequest(
    turnContext: Awaited<
      ReturnType<ChatV2TurnContextService['buildTurnContext']>
    >,
    classification: ChatV2TurnClassification,
  ): Promise<ChatV2AssistantDraft> {
    const taskRoute = await this.taskRouter.route({
      turnContext,
      classification,
    });

    switch (taskRoute.domain) {
      case 'chat_history': {
        if (taskRoute.historyIntent === 'conversation_summary') {
          const response = await this.chatHistorySummaryResponder.respond({
            turnContext,
            classification,
          });

          return {
            content: response.content,
            answerRoute: 'chat_history',
            classification,
            taskRoute,
            usedLlm: true,
            usedChatHistory: true,
            usedChatHistorySummary: true,
            sourceOfTruth: 'chat_history',
            extraContext: {
              historyMessageCount: turnContext.messageHistory.length,
              ...(response.responseId
                ? { llmResponseId: response.responseId }
                : {}),
            },
          };
        }

        const response = await this.chatHistoryResponder.respond({
          turnContext,
          route: taskRoute,
          language: classification.language,
        });

        return {
          content: response.content,
          answerRoute: 'chat_history',
          classification,
          taskRoute,
          usedLlm: false,
          usedChatHistory: true,
          sourceOfTruth: 'chat_history',
          extraContext: {
            historyMessageCount: turnContext.messageHistory.length,
          },
        };
      }
      case 'general_web': {
        const response = await this.generalWebResponder.respond({
          route: taskRoute,
          userQuery: turnContext.userQuery,
          language: classification.language,
        });

        return {
          content: response.content,
          answerRoute: 'general_web',
          classification,
          taskRoute,
          usedLlm: true,
          usedWebSearch: true,
          sourceOfTruth: 'web_search',
          contextReferences: response.citations,
          extraContext: {
            llmResponseId: response.responseId,
            webSearchQuery: response.webSearchQuery,
            webSearchSourceCount: response.sourceCount,
            historyMessageCount: turnContext.messageHistory.length,
          },
        };
      }
      case 'ship_task': {
        const metricsResult = await this.metricsV2Responder.respond({
          shipId: turnContext.shipId,
          shipName: turnContext.shipName,
          shipOrganizationName: turnContext.shipOrganizationName,
          userQuery: turnContext.userQuery,
          language: classification.language,
          recentMessages: turnContext.previousMessages,
        });

        if (metricsResult.handled && metricsResult.content) {
          return {
            content: metricsResult.content,
            answerRoute: 'metrics_v2',
            classification,
            taskRoute,
            usedLlm: true,
            usedCurrentTelemetry: metricsResult.usedCurrentMetrics,
            usedHistoricalTelemetry: metricsResult.usedHistoricalMetrics,
            sourceOfTruth: metricsResult.sourceOfTruth ?? 'current_metrics',
            extraContext: {
              metricsV2: true,
              metricsV2Classification: metricsResult.classification ?? null,
              metricsV2Plan: metricsResult.plan ?? null,
              metricsV2Debug: metricsResult.debug ?? null,
              ...(metricsResult.pendingClarification
                ? {
                    pendingClarification: metricsResult.pendingClarification,
                  }
                : {}),
              historyMessageCount: turnContext.messageHistory.length,
            },
          };
        }

        const response = await this.unsupportedShipTaskResponder.respond({
          language: classification.language,
          userQuery: turnContext.userQuery,
        });

        return {
          content: response.content,
          answerRoute: 'ship_task_placeholder',
          classification,
          taskRoute,
          usedLlm: false,
          sourceOfTruth: 'ship_task_placeholder',
          extraContext: {
            shipTaskRoutingPending: true,
            historyMessageCount: turnContext.messageHistory.length,
          },
        };
      }
      case 'unknown':
      default:
        return {
          content: await this.buildUnknownTaskResponse({
            language: classification.language,
            userQuery: turnContext.userQuery,
          }),
          answerRoute: 'unknown_task',
          classification,
          taskRoute,
          usedLlm: false,
          sourceOfTruth: 'unknown',
          extraContext: {
            historyMessageCount: turnContext.messageHistory.length,
          },
        };
    }
  }

  private buildUnknownTaskResponse(params: {
    language: ChatV2TurnClassification['language'];
    userQuery: string;
  }): Promise<string> {
    return this.fallbackWriter.write({
      language: params.language,
      key: 'fallback.unknown_task',
      userQuery: params.userQuery,
    });
  }
}
