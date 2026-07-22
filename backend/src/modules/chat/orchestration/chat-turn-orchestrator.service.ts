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
import { ChatMetricAnalyzerResponderService } from '../responders/chat-metric-analyzer-responder.service';
import { ChatComplianceResponderService } from '../responders/chat-compliance-responder.service';
import { ChatFilesResponderService } from '../responders/chat-files-responder.service';
import { ChatMetricsResponderService } from '../responders/chat-metrics-responder.service';
import { ChatPmsResponderService } from '../responders/chat-pms-responder.service';
import { ChatSmallTalkResponderService } from '../responders/chat-small-talk-responder.service';
import { ChatWebSearchResponderService } from '../responders/chat-web-search-responder.service';
import { ChatTurnAskResult } from '../responders/interfaces/chat-turn-responder.types';
import {
  composeDocumentOnlyResults,
  filterContextReferencesForAnswer,
} from './document-results/document-result-composition';
import {
  buildChatPlannerDiagnosticsContext,
  ChatPlannerDiagnosticsContext,
} from './chat-planner-diagnostics';
import {
  composeDocumentsAndWebResults,
  composeFallbackAwareDocumentResults,
} from './chat-source-result-composition';
import { buildDocumentFallbackWebQuery } from './chat-document-web-query';
import { ChatProgressBus } from '../progress/chat-progress.bus';
import { ChatUiLabelsService } from '../chat-ui-labels.service';
import {
  buildDocumentsWebFallbackSearchQuestion,
  DocumentsWebFallbackDiagnostics,
  evaluateDocumentsWebFallback,
  getDocumentsWebFallbackDiagnostics,
  isDocumentsWebFallbackRoute,
  markDocumentsWebFallbackExecuted,
  markDocumentsWebFallbackFailed,
  withDocumentsWebFallbackDiagnostics,
} from './chat-documents-web-fallback';

@Injectable()
export class ChatTurnOrchestratorService {
  /**
   * How many decomposed sub-asks run at once. Both providers handle 2 at
   * current account tiers (Anthropic verified at 2M input-tokens/min).
   * If an Anthropic key ever drops back to Tier 1 (30K ITPM), set this to
   * 1 for claude-* — two parallel cold asks with the ~45K-token catalog
   * prompt exhaust the minute window and every retry 429s.
   */
  private readonly askExecutionConcurrency = 2;

  constructor(
    private readonly chatTurnPlannerService: ChatTurnPlannerService,
    private readonly chatLlmService: ChatLlmService,
    private readonly configService: ConfigService,
    private readonly chatSmallTalkResponderService: ChatSmallTalkResponderService,
    private readonly chatWebSearchResponderService: ChatWebSearchResponderService,
    private readonly chatMetricsResponderService: ChatMetricsResponderService,
    private readonly chatMetricAnalyzerResponderService: ChatMetricAnalyzerResponderService,
    private readonly chatDocumentsResponderService: ChatDocumentsResponderService,
    private readonly chatPmsResponderService: ChatPmsResponderService,
    private readonly chatComplianceResponderService: ChatComplianceResponderService,
    private readonly chatFilesResponderService: ChatFilesResponderService,
    private readonly chatInDevelopmentResponderService: ChatInDevelopmentResponderService,
    private readonly chatProgressBus: ChatProgressBus,
    private readonly chatUiLabelsService: ChatUiLabelsService,
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
    // Chart click-to-ask UI strings (button labels + composed question),
    // translated into whatever language this turn is answering in — kicked
    // off in parallel with the rest of the turn so it never adds latency
    // (translation only runs once per distinct language; cached after).
    const chartLabelsPromise = this.chatUiLabelsService.getChartLabels(
      plan.responseLanguage,
    );
    const result = await this.respondForPlan(input, plan);
    const chartLabels = await chartLabelsPromise;
    return {
      content: result.content,
      ragflowContext: result.ragflowContext
        ? { ...result.ragflowContext, chartLabels }
        : { chartLabels },
    };
  }

  private async respondForPlan(
    input: {
      session: ChatSessionEntity;
      messages: ChatMessageEntity[];
      context: ChatConversationContext;
    },
    plan: ChatTurnPlan,
  ): Promise<{
    content: string;
    ragflowContext: Record<string, unknown> | null;
  }> {
    const asks = plan.asks;

    if (
      asks.length === 1 &&
      asks[0].responder === ChatTurnResponderKind.SMALL_TALK &&
      !this.shouldUseDocumentsResponder(asks[0]) &&
      !this.shouldUsePmsResponder(asks[0]) &&
      !this.shouldUseComplianceResponder(asks[0]) &&
      !this.shouldUseFilesResponder(asks[0])
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
          planner: this.buildPlannerContext(plan, [singleResult]),
          askResults: [singleResult],
        },
      };
    }

    const askResults = this.shouldUseDocumentContextualWebExecution(asks)
      ? await this.executeDocumentContextualWebPlan({
          plan,
          asks,
          session: input.session,
          messages: input.messages,
          context: input.context,
        })
      : await this.mapWithConcurrencyLimit(
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
      (askResults[0].responder === ChatTurnResponderKind.DOCUMENTS ||
        askResults[0].responder === ChatTurnResponderKind.METRICS ||
        askResults[0].responder === ChatTurnResponderKind.PMS ||
        askResults[0].responder === ChatTurnResponderKind.COMPLIANCE ||
        askResults[0].responder === ChatTurnResponderKind.FILES)
    ) {
      // Single-ask pass-through: the metric-analyzer responder already
      // produces a polished, user-facing answer in the user's language.
      // Re-composing it through the sub-LLM adds 3-8 s of latency, risks
      // restyling correct numbers, and adds nothing — same rationale as
      // the documents pass-through above.
      return {
        content: askResults[0].summary,
        ragflowContext: {
          contextReferences: askResults[0].contextReferences ?? [],
          planner: this.buildPlannerContext(plan, askResults),
          askResults,
        },
      };
    }

    const fallbackAwareDocumentReply =
      composeFallbackAwareDocumentResults(askResults);

    if (fallbackAwareDocumentReply) {
      return {
        content: fallbackAwareDocumentReply.content,
        ragflowContext: {
          contextReferences: fallbackAwareDocumentReply.contextReferences,
          planner: this.buildPlannerContext(plan, askResults),
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
          planner: this.buildPlannerContext(plan, askResults),
          askResults,
        },
      };
    }

    const documentsAndWebReply = composeDocumentsAndWebResults(askResults);

    if (documentsAndWebReply) {
      return {
        content: documentsAndWebReply.content,
        ragflowContext: {
          contextReferences: documentsAndWebReply.contextReferences,
          planner: this.buildPlannerContext(plan, askResults),
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
        planner: this.buildPlannerContext(plan, askResults),
        askResults,
      },
    };
  }

  private async executeAsk(input: {
    plan: ChatTurnPlan;
    ask: ChatTurnPlanAsk;
    session: ChatSessionEntity;
    messages: ChatMessageEntity[];
    context: ChatConversationContext;
  }): Promise<ChatTurnAskResult> {
    this.chatProgressBus.emit(input.session.id, {
      type: 'ask_started',
      text: this.describeAskForProgress(input.ask),
    });

    if (this.shouldUsePmsResponder(input.ask)) {
      return this.chatPmsResponderService.respond(input);
    }

    if (this.shouldUseComplianceResponder(input.ask)) {
      return this.chatComplianceResponderService.respond(input);
    }

    if (this.shouldUseFilesResponder(input.ask)) {
      return this.chatFilesResponderService.respond(input);
    }

    if (this.shouldUseDocumentsResponder(input.ask)) {
      const documentResult = await this.chatDocumentsResponderService.respond(input);

      return this.executeDocumentsWebFallbackIfNeeded(input, documentResult);
    }

    switch (input.ask.responder) {
      case ChatTurnResponderKind.WEB_SEARCH:
        return this.chatWebSearchResponderService.respond(input);
      case ChatTurnResponderKind.METRICS:
        return this.shouldUseMetricAnalyzerResponder()
          ? this.chatMetricAnalyzerResponderService.respond(input)
          : this.chatMetricsResponderService.respond(input);
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

  private async executeDocumentContextualWebPlan(input: {
    plan: ChatTurnPlan;
    asks: ChatTurnPlanAsk[];
    session: ChatSessionEntity;
    messages: ChatMessageEntity[];
    context: ChatConversationContext;
  }): Promise<ChatTurnAskResult[]> {
    const results = new Array<ChatTurnAskResult>(input.asks.length);
    const documentIndexes = input.asks
      .map((ask, index) => ({ ask, index }))
      .filter(({ ask }) => this.shouldUseDocumentsResponder(ask));

    await Promise.all(
      documentIndexes.map(async ({ ask, index }) => {
        results[index] = await this.executeAsk({
          plan: input.plan,
          ask,
          session: input.session,
          messages: input.messages,
          context: input.context,
        });
      }),
    );

    for (const [index, ask] of input.asks.entries()) {
      if (results[index]) {
        continue;
      }

      const contextualAsk =
        ask.responder === ChatTurnResponderKind.WEB_SEARCH
          ? this.buildDocumentContextualWebAsk(ask, results)
          : ask;
      const contextualPlan =
        contextualAsk === ask
          ? input.plan
          : {
              ...input.plan,
              asks: input.plan.asks.map((planAsk) =>
                planAsk.id === contextualAsk.id ? contextualAsk : planAsk,
              ),
            };

      results[index] = await this.executeAsk({
        plan: contextualPlan,
        ask: contextualAsk,
        session: input.session,
        messages: input.messages,
        context: input.context,
      });
    }

    return results;
  }

  private buildDocumentContextualWebAsk(
    ask: ChatTurnPlanAsk,
    askResults: ChatTurnAskResult[],
  ): ChatTurnPlanAsk {
    const documentResult = askResults.find(
      (result) => result?.responder === ChatTurnResponderKind.DOCUMENTS,
    );

    if (!documentResult) {
      return ask;
    }

    const contextualQuestion = buildDocumentFallbackWebQuery({
      ask,
      documentResult,
    });

    if (!contextualQuestion || contextualQuestion === ask.question) {
      return ask;
    }

    return {
      ...ask,
      question: contextualQuestion,
    };
  }

  private buildPlannerContext(
    plan: ChatTurnPlan,
    askResults: ChatTurnAskResult[] = [],
  ): ChatPlannerDiagnosticsContext {
    const webFallbackDiagnosticsByAskId = new Map<
      string,
      DocumentsWebFallbackDiagnostics
    >();

    for (const result of askResults) {
      const diagnostics = getDocumentsWebFallbackDiagnostics(result);

      if (diagnostics) {
        webFallbackDiagnosticsByAskId.set(result.askId, diagnostics);
      }
    }

    return buildChatPlannerDiagnosticsContext({
      plan,
      resolveSelectedResponder: (ask) => this.resolveSelectedResponderKind(ask),
      resolveWebFallbackDiagnostics: (ask) =>
        webFallbackDiagnosticsByAskId.get(ask.id) ?? null,
    });
  }

  private async executeDocumentsWebFallbackIfNeeded(
    input: {
      plan: ChatTurnPlan;
      ask: ChatTurnPlanAsk;
      session: ChatSessionEntity;
      messages: ChatMessageEntity[];
      context: ChatConversationContext;
    },
    documentResult: ChatTurnAskResult,
  ): Promise<ChatTurnAskResult> {
    const diagnostics = evaluateDocumentsWebFallback({
      ask: input.ask,
      selectedResponder: this.resolveSelectedResponderKind(input.ask),
      documentResult,
    });

    if (diagnostics.action !== 'executed') {
      return withDocumentsWebFallbackDiagnostics(documentResult, diagnostics);
    }

    try {
      const fallbackQuestion = buildDocumentsWebFallbackSearchQuestion({
        ask: input.ask,
        diagnostics,
        documentResult,
      });
      const fallbackAsk = {
        ...input.ask,
        id: `${input.ask.id}-web-fallback`,
        question: fallbackQuestion,
        responder: ChatTurnResponderKind.WEB_SEARCH,
        capabilityEnabled: true,
        capabilityLabel: 'web fallback',
      };
      const webResult = await this.chatWebSearchResponderService.respond({
        ...input,
        plan: {
          ...input.plan,
          asks:
            input.plan.asks.length === 1
              ? [input.ask, fallbackAsk]
              : input.plan.asks,
        },
        ask: fallbackAsk,
      });
      const executedDiagnostics = markDocumentsWebFallbackExecuted(
        diagnostics,
        webResult,
        fallbackQuestion,
      );

      return withDocumentsWebFallbackDiagnostics(
        documentResult,
        executedDiagnostics,
        webResult,
      );
    } catch (error) {
      return withDocumentsWebFallbackDiagnostics(
        documentResult,
        markDocumentsWebFallbackFailed(diagnostics, error),
      );
    }
  }

  private resolveSelectedResponderKind(
    ask: ChatTurnPlanAsk,
  ): ChatTurnResponderKind {
    if (this.shouldUseDocumentsResponder(ask)) {
      return ChatTurnResponderKind.DOCUMENTS;
    }

    return ask.responder;
  }

  private shouldUseMetricAnalyzerResponder(): boolean {
    return (
      this.configService.get<boolean>('chat.metricAnalyzerEnabled', true) === true
    );
  }

  private shouldUseDocumentsResponder(ask: ChatTurnPlanAsk): boolean {
    return (
      this.configService.get<boolean>('chat.documentsResponderEnabled', false) ===
        true &&
      (ask.semanticRoute.route === ChatSemanticRoute.DOCUMENTS ||
        isDocumentsWebFallbackRoute(ask))
    );
  }

  /**
   * PMS/maintenance asks are answered from the structured Tasks register, not
   * documents. Route-gated like the documents responder.
   */
  private shouldUsePmsResponder(ask: ChatTurnPlanAsk): boolean {
    return ask.semanticRoute.route === ChatSemanticRoute.PMS;
  }

  /**
   * Certificate/compliance asks are answered from the structured Compliance
   * Docs register, not documents. Route-gated like the PMS responder.
   */
  private shouldUseComplianceResponder(ask: ChatTurnPlanAsk): boolean {
    return ask.semanticRoute.route === ChatSemanticRoute.COMPLIANCE;
  }

  /**
   * "Show me / open / give me the file" asks return the original document via a
   * metadata catalog lookup. Route-gated like the other structured responders.
   */
  private shouldUseFilesResponder(ask: ChatTurnPlanAsk): boolean {
    return ask.semanticRoute.route === ChatSemanticRoute.FILES;
  }

  private shouldUseDocumentContextualWebExecution(
    asks: ChatTurnPlanAsk[],
  ): boolean {
    const hasDocumentAsk = asks.some((ask) => this.shouldUseDocumentsResponder(ask));
    const hasWebAsk = asks.some(
      (ask) => ask.responder === ChatTurnResponderKind.WEB_SEARCH,
    );
    const hasMetricsAsk = asks.some(
      (ask) =>
        ask.responder === ChatTurnResponderKind.METRICS ||
        ask.semanticRoute.sourcePolicy.allowMetrics,
    );

    return hasDocumentAsk && hasWebAsk && !hasMetricsAsk;
  }

  /** Short human-readable progress line for an ask. */
  private describeAskForProgress(ask: ChatTurnPlanAsk): string {
    const q = ask.question.length > 80 ? ask.question.slice(0, 77) + '…' : ask.question;
    // PMS is route-gated, so the planner's responder kind may still read
    // metrics/small_talk — branch on the route first for an accurate label.
    if (ask.semanticRoute.route === ChatSemanticRoute.PMS) {
      return `Checking maintenance tasks: ${q}`;
    }
    if (ask.semanticRoute.route === ChatSemanticRoute.COMPLIANCE) {
      return `Checking certificates & compliance: ${q}`;
    }
    if (ask.semanticRoute.route === ChatSemanticRoute.FILES) {
      return `Finding the file: ${q}`;
    }
    switch (ask.responder) {
      case ChatTurnResponderKind.METRICS:
        return `Analyzing telemetry: ${q}`;
      case ChatTurnResponderKind.DOCUMENTS:
        return `Searching ship manuals: ${q}`;
      case ChatTurnResponderKind.WEB_SEARCH:
        return `Searching the web: ${q}`;
      default:
        return q;
    }
  }
}
