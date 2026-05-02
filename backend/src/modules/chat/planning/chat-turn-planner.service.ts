import { Injectable } from '@nestjs/common';
import { ChatConversationContext } from '../context/chat-conversation-context.types';
import { ChatCapabilityRegistryService } from './chat-capability-registry.service';
import { ChatTurnClassifierService } from './chat-turn-classifier.service';
import { ChatTurnDecomposerService } from './chat-turn-decomposer.service';
import { ChatMetricsTimeNormalizerService } from './chat-metrics-time-normalizer.service';
import { ChatTurnIntent } from './chat-turn-intent.enum';
import { ChatTurnPlan } from './chat-turn-plan.types';
import {
  ChatSemanticRoute,
  ChatSemanticRouteDecision,
} from '../routing/chat-semantic-router.types';
import { ChatSemanticRouterService } from '../routing/chat-semantic-router.service';

@Injectable()
export class ChatTurnPlannerService {
  constructor(
    private readonly chatTurnDecomposerService: ChatTurnDecomposerService,
    private readonly chatTurnClassifierService: ChatTurnClassifierService,
    private readonly chatCapabilityRegistryService: ChatCapabilityRegistryService,
    private readonly chatMetricsTimeNormalizerService: ChatMetricsTimeNormalizerService,
    private readonly chatSemanticRouterService: ChatSemanticRouterService,
  ) {}

  async plan(context: ChatConversationContext): Promise<ChatTurnPlan> {
    const decomposition = await this.chatTurnDecomposerService.decompose(context);
    const classifiedAsks = await Promise.all(
      decomposition.asks.map((ask) =>
        this.chatTurnClassifierService.classifyAsk({
          context,
          question: ask.question,
        }),
      ),
    );
    let normalizedAsks = await Promise.all(
      classifiedAsks.map((ask) =>
        this.chatMetricsTimeNormalizerService.normalizeAsk(ask, context),
      ),
    );
    let semanticRoutes = await Promise.all(
      normalizedAsks.map((ask) =>
        this.chatSemanticRouterService.route({
          question: ask.question,
          shipId: context.session.shipId,
          responseLanguage: decomposition.responseLanguage,
        }),
      ),
    );
    const documentOnlyCompositeRoute =
      await this.resolveDocumentOnlyCompositeRoute({
        context,
        responseLanguage: decomposition.responseLanguage,
        semanticRoutes,
      });

    if (documentOnlyCompositeRoute) {
      const originalQuestion =
        context.latestUserMessage?.content.trim() || normalizedAsks[0].question;
      const originalClassification =
        await this.chatTurnClassifierService.classifyAsk({
          context,
          question: originalQuestion,
        });
      const normalizedOriginal =
        await this.chatMetricsTimeNormalizerService.normalizeAsk(
          {
            ...originalClassification,
            question: originalQuestion,
          },
          context,
        );

      normalizedAsks = [
        {
          ...normalizedOriginal,
          question: originalQuestion,
        },
      ];
      semanticRoutes = [documentOnlyCompositeRoute];
    }

    return {
      asks: normalizedAsks.map((ask, index) => {
        const capability = this.chatCapabilityRegistryService.resolve(ask.intent);

        return {
          id: `ask-${index + 1}`,
          intent: capability.intent ?? ChatTurnIntent.SMALL_TALK,
          responder: capability.responder,
          question: ask.question,
          capabilityEnabled: capability.enabled,
          capabilityLabel: capability.label,
          timeMode: ask.timeMode,
          timestamp: ask.timestamp,
          rangeStart: ask.rangeStart,
          rangeEnd: ask.rangeEnd,
          semanticRoute: semanticRoutes[index],
        };
      }),
      responseLanguage: decomposition.responseLanguage,
      reasoning: documentOnlyCompositeRoute
        ? `${decomposition.reasoning} Document-only composite routing kept the user turn as one documents ask.`
        : decomposition.reasoning,
    };
  }

  private async resolveDocumentOnlyCompositeRoute(input: {
    context: ChatConversationContext;
    responseLanguage: string | null;
    semanticRoutes: ChatSemanticRouteDecision[];
  }): Promise<ChatSemanticRouteDecision | null> {
    if (
      input.semanticRoutes.length < 2 ||
      !input.semanticRoutes.every(
        (route) => route.route === ChatSemanticRoute.DOCUMENTS,
      )
    ) {
      return null;
    }

    const originalQuestion = input.context.latestUserMessage?.content.trim();

    if (originalQuestion) {
      const originalRoute = await this.chatSemanticRouterService.route({
        question: originalQuestion,
        shipId: input.context.session.shipId,
        responseLanguage: input.responseLanguage,
      });

      if (this.isValidDocumentCompositeRoute(originalRoute)) {
        return originalRoute;
      }
    }

    return (
      input.semanticRoutes.find((route) =>
        this.isValidDocumentCompositeRoute(route),
      ) ?? null
    );
  }

  private isValidDocumentCompositeRoute(
    route: ChatSemanticRouteDecision,
  ): boolean {
    return (
      route.route === ChatSemanticRoute.DOCUMENTS &&
      route.documents.mode === 'composite' &&
      route.documents.components.length >= 2
    );
  }
}
