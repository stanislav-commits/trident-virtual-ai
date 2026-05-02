import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatLlmService } from '../chat-llm.service';
import { ChatConversationContext } from '../context/chat-conversation-context.types';
import { ChatMessageEntity } from '../entities/chat-message.entity';
import { ChatSessionEntity } from '../entities/chat-session.entity';
import { ChatTurnPlan, ChatTurnPlanAsk } from '../planning/chat-turn-plan.types';
import { ChatTurnPlannerService } from '../planning/chat-turn-planner.service';
import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import { ChatSemanticRoute } from '../routing/chat-semantic-router.types';
import { ChatDocumentsResponderService } from '../responders/documents/chat-documents-responder.service';
import { ChatInDevelopmentResponderService } from '../responders/chat-in-development-responder.service';
import { ChatMetricsResponderService } from '../responders/chat-metrics-responder.service';
import { ChatSmallTalkResponderService } from '../responders/chat-small-talk-responder.service';
import { ChatWebSearchResponderService } from '../responders/chat-web-search-responder.service';
import { ChatTurnAskResult } from '../responders/interfaces/chat-turn-responder.types';
import {
  composeDocumentOnlyResults,
  filterContextReferencesForAnswer,
} from './document-results/document-result-composition';

@Injectable()
export class ChatTurnOrchestratorService {
  private readonly askExecutionConcurrency = 2;

  constructor(
    private readonly chatTurnPlannerService: ChatTurnPlannerService,
    private readonly chatLlmService: ChatLlmService,
    private readonly configService: ConfigService,
    private readonly chatSmallTalkResponderService: ChatSmallTalkResponderService,
    private readonly chatWebSearchResponderService: ChatWebSearchResponderService,
    private readonly chatMetricsResponderService: ChatMetricsResponderService,
    private readonly chatDocumentsResponderService: ChatDocumentsResponderService,
    private readonly chatInDevelopmentResponderService: ChatInDevelopmentResponderService,
  ) {}

  async respond(input: {
    session: ChatSessionEntity;
    messages: ChatMessageEntity[];
    context: ChatConversationContext;
  }): Promise<{
    content: string;
    ragflowContext: Record<string, unknown> | null;
  }> {
    const plan = await this.chatTurnPlannerService.plan(input.context);
    const asks = plan.asks;

    if (
      asks.length === 1 &&
      asks[0].responder === ChatTurnResponderKind.SMALL_TALK &&
      !this.shouldUseDocumentsResponder(asks[0])
    ) {
      const singleResult = await this.chatSmallTalkResponderService.respond({
        plan,
        ask: asks[0],
        session: input.session,
        messages: input.messages,
        context: input.context,
      });

      return {
        content: singleResult.summary,
        ragflowContext: {
          planner: this.buildPlannerContext(plan),
          askResults: [singleResult],
        },
      };
    }

    const askResults = await this.mapWithConcurrencyLimit(
      asks,
      this.askExecutionConcurrency,
      (ask) =>
        this.executeAsk({
          plan,
          ask,
          session: input.session,
          messages: input.messages,
          context: input.context,
        }),
    );

    if (
      askResults.length === 1 &&
      askResults[0].responder === ChatTurnResponderKind.DOCUMENTS
    ) {
      return {
        content: askResults[0].summary,
        ragflowContext: {
          contextReferences: askResults[0].contextReferences ?? [],
          planner: this.buildPlannerContext(plan),
          askResults,
        },
      };
    }

    if (
      askResults.length > 1 &&
      askResults.every(
        (result) => result.responder === ChatTurnResponderKind.DOCUMENTS,
      )
    ) {
      const documentOnlyReply = composeDocumentOnlyResults(askResults);

      return {
        content: documentOnlyReply.content,
        ragflowContext: {
          contextReferences: documentOnlyReply.contextReferences,
          planner: this.buildPlannerContext(plan),
          askResults,
        },
      };
    }

    const content = await this.chatLlmService.composeAskResultsReply({
      context: input.context,
      responseLanguage: plan.responseLanguage,
      askResults,
    });
    const contextReferences = filterContextReferencesForAnswer(
      content,
      askResults.flatMap((result) => result.contextReferences ?? []),
    );

    return {
      content,
      ragflowContext: {
        contextReferences,
        planner: this.buildPlannerContext(plan),
        askResults,
      },
    };
  }

  private executeAsk(input: {
    plan: ChatTurnPlan;
    ask: ChatTurnPlanAsk;
    session: ChatSessionEntity;
    messages: ChatMessageEntity[];
    context: ChatConversationContext;
  }): Promise<ChatTurnAskResult> {
    if (this.shouldUseDocumentsResponder(input.ask)) {
      return this.chatDocumentsResponderService.respond(input);
    }

    switch (input.ask.responder) {
      case ChatTurnResponderKind.WEB_SEARCH:
        return this.chatWebSearchResponderService.respond(input);
      case ChatTurnResponderKind.METRICS:
        return this.chatMetricsResponderService.respond(input);
      case ChatTurnResponderKind.IN_DEVELOPMENT:
        return this.chatInDevelopmentResponderService.respond(input);
      case ChatTurnResponderKind.SMALL_TALK:
      default:
        return this.chatSmallTalkResponderService.respond(input);
    }
  }

  private async mapWithConcurrencyLimit<TInput, TOutput>(
    items: TInput[],
    concurrency: number,
    worker: (item: TInput, index: number) => Promise<TOutput>,
  ): Promise<TOutput[]> {
    const normalizedConcurrency = Math.max(1, Math.floor(concurrency));
    const results = new Array<TOutput>(items.length);
    let nextIndex = 0;

    const runWorker = async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= items.length) {
          return;
        }

        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(normalizedConcurrency, items.length) },
        () => runWorker(),
      ),
    );

    return results;
  }

  private buildPlannerContext(plan: ChatTurnPlan): {
    reasoning: string;
    asks: Array<Omit<ChatTurnPlanAsk, 'semanticRoute'>>;
  } {
    return {
      reasoning: plan.reasoning,
      asks: plan.asks.map((ask) => {
        const { semanticRoute: _semanticRoute, ...contextAsk } = ask;

        return contextAsk;
      }),
    };
  }

  private shouldUseDocumentsResponder(ask: ChatTurnPlanAsk): boolean {
    return (
      this.configService.get<boolean>('chat.documentsResponderEnabled', false) ===
        true &&
      ask.semanticRoute.route === ChatSemanticRoute.DOCUMENTS
    );
  }
}
