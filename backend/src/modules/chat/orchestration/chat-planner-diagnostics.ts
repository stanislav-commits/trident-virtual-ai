import { ChatTurnPlan, ChatTurnPlanAsk } from '../planning/chat-turn-plan.types';
import { ChatTurnResponderKind } from '../planning/chat-turn-responder-kind.enum';
import { ChatSemanticRoute } from '../routing/chat-semantic-router.types';
import {
  DocumentsWebFallbackDiagnostics,
  isDocumentsWebFallbackRoute,
} from './chat-documents-web-fallback';

interface BuildChatPlannerDiagnosticsContextInput {
  plan: ChatTurnPlan;
  resolveSelectedResponder: (ask: ChatTurnPlanAsk) => ChatTurnResponderKind;
  resolveWebFallbackDiagnostics?: (
    ask: ChatTurnPlanAsk,
  ) => DocumentsWebFallbackDiagnostics | null;
}

export interface ChatPlannerDiagnosticsContext {
  reasoning: string;
  diagnostics: {
    schemaVersion: 1;
    safeForClient: true;
    runtimeBehaviorChanged: boolean;
    note: string;
  };
  asks: Array<
    Omit<ChatTurnPlanAsk, 'semanticRoute'> & {
      semanticDiagnostics: ChatPlannerAskSemanticDiagnostics;
    }
  >;
}

export interface ChatPlannerAskSemanticDiagnostics {
  classifierIntent: string;
  selectedResponder: ChatTurnResponderKind;
  semanticRoute: ChatSemanticRoute;
  primaryRoute: ChatSemanticRoute;
  confidence: number;
  requiresClarification: boolean;
  clarificationQuestion: string | null;
  sourcePolicy: {
    allowDocuments: boolean;
    allowMetrics: boolean;
    allowWeb: boolean;
    allowWebFallback: boolean;
    allowMixedComposition: boolean;
  };
  allowWebFallback: boolean;
  explicitWebFallback: boolean;
  freshnessRequired: boolean;
  latestInfoIntent: boolean;
  mixedSourceIntent: boolean;
  fallbackRoutes: ChatSemanticRoute[];
  documents: {
    mode: string;
    questionType: string | null;
    candidateDocClasses: string[];
    equipmentOrSystemHints: string[];
    manufacturerHints: string[];
    modelHints: string[];
    contentFocusHints: string[];
    documentTitleHint: string | null;
    retrievalQuery: string | null;
    answerLanguage: string | null;
    languageHint: string | null;
    multiDocumentLikely: boolean;
    compositionMode: string | null;
    componentCount: number;
    components: Array<{
      id: string;
      label: string | null;
      questionType: string | null;
      candidateDocClasses: string[];
      documentTitleHint: string | null;
      requireDocumentTitleMatch: boolean;
      languageHint: string | null;
      hasRetrievalQuery: boolean;
    }>;
  };
  metrics: {
    semanticTimeMode: string | null;
    semanticTimestamp: string | null;
    semanticRangeStart: string | null;
    semanticRangeEnd: string | null;
    classifierTimeMode: string | null;
    classifierTimestamp: string | null;
    classifierRangeStart: string | null;
    classifierRangeEnd: string | null;
  };
  web: {
    externalKnowledgeExplicit: boolean;
    freshnessRequired: boolean;
  };
  webFallback: DocumentsWebFallbackDiagnostics | null;
  executionLimitations: string[];
}

export function buildChatPlannerDiagnosticsContext(
  input: BuildChatPlannerDiagnosticsContextInput,
): ChatPlannerDiagnosticsContext {
  const webFallbackDiagnostics = input.plan.asks
    .map((ask) => input.resolveWebFallbackDiagnostics?.(ask) ?? null)
    .filter((value): value is DocumentsWebFallbackDiagnostics => value !== null);
  const runtimeBehaviorChanged = webFallbackDiagnostics.some(
    (diagnostics) =>
      diagnostics.action === 'executed' || diagnostics.action === 'failed',
  );

  return {
    reasoning: input.plan.reasoning,
    diagnostics: {
      schemaVersion: 1,
      safeForClient: true,
      runtimeBehaviorChanged,
      note: runtimeBehaviorChanged
        ? 'Semantic routing diagnostics include documents-first web-fallback execution details.'
        : 'Semantic routing diagnostics only. These fields do not change selected responders or source execution.',
    },
    asks: input.plan.asks.map((ask) => {
      const { semanticRoute: _semanticRoute, ...contextAsk } = ask;

      return {
        ...contextAsk,
        semanticDiagnostics: buildAskSemanticDiagnostics({
          ask,
          selectedResponder: input.resolveSelectedResponder(ask),
          webFallback:
            input.resolveWebFallbackDiagnostics?.(ask) ?? null,
        }),
      };
    }),
  };
}

function buildAskSemanticDiagnostics(input: {
  ask: ChatTurnPlanAsk;
  selectedResponder: ChatTurnResponderKind;
  webFallback: DocumentsWebFallbackDiagnostics | null;
}): ChatPlannerAskSemanticDiagnostics {
  const route = input.ask.semanticRoute;
  const sourcePolicy = route.sourcePolicy;
  const explicitWebFallback =
    input.webFallback?.explicitWebFallback ?? hasExplicitWebFallbackIntent(input.ask);
  const mixedSourceIntent = hasMixedSourceIntent(input.ask);
  const freshnessRequired =
    input.webFallback?.freshnessRequired ?? route.web.freshnessRequired;

  return {
    classifierIntent: input.ask.intent,
    selectedResponder: input.selectedResponder,
    semanticRoute: route.route,
    primaryRoute: route.route,
    confidence: route.confidence,
    requiresClarification: route.requiresClarification,
    clarificationQuestion: route.clarificationQuestion,
    sourcePolicy: {
      allowDocuments: sourcePolicy.allowDocuments,
      allowMetrics: sourcePolicy.allowMetrics,
      allowWeb: sourcePolicy.allowWeb,
      allowWebFallback: sourcePolicy.allowWebFallback,
      allowMixedComposition: sourcePolicy.allowMixedComposition,
    },
    allowWebFallback: sourcePolicy.allowWebFallback,
    explicitWebFallback,
    freshnessRequired,
    latestInfoIntent: freshnessRequired,
    mixedSourceIntent,
    fallbackRoutes:
      explicitWebFallback ||
      sourcePolicy.allowWebFallback ||
      freshnessRequired ||
      input.webFallback?.automaticFallback
        ? [ChatSemanticRoute.WEB]
        : [],
    documents: {
      mode: route.documents.mode,
      questionType: route.documents.questionType,
      candidateDocClasses: route.documents.candidateDocClasses,
      equipmentOrSystemHints: route.documents.equipmentOrSystemHints,
      manufacturerHints: route.documents.manufacturerHints,
      modelHints: route.documents.modelHints,
      contentFocusHints: route.documents.contentFocusHints,
      documentTitleHint: route.documents.documentTitleHint,
      retrievalQuery: route.documents.retrievalQuery ?? null,
      answerLanguage: route.documents.answerLanguage ?? null,
      languageHint: route.documents.languageHint,
      multiDocumentLikely: route.documents.multiDocumentLikely,
      compositionMode: route.documents.compositionMode,
      componentCount: route.documents.components.length,
      components: route.documents.components.map((component) => ({
        id: component.id,
        label: component.label,
        questionType: component.questionType,
        candidateDocClasses: component.candidateDocClasses,
        documentTitleHint: component.documentTitleHint,
        requireDocumentTitleMatch: component.requireDocumentTitleMatch,
        languageHint: component.languageHint,
        hasRetrievalQuery: Boolean(component.retrievalQuery?.trim()),
      })),
    },
    metrics: {
      semanticTimeMode: route.metrics.timeMode,
      semanticTimestamp: route.metrics.timestamp,
      semanticRangeStart: route.metrics.rangeStart,
      semanticRangeEnd: route.metrics.rangeEnd,
      classifierTimeMode: input.ask.timeMode,
      classifierTimestamp: input.ask.timestamp,
      classifierRangeStart: input.ask.rangeStart,
      classifierRangeEnd: input.ask.rangeEnd,
    },
    web: {
      externalKnowledgeExplicit: route.web.externalKnowledgeExplicit,
      freshnessRequired,
    },
    webFallback: input.webFallback,
    executionLimitations: buildExecutionLimitations({
      ask: input.ask,
      selectedResponder: input.selectedResponder,
      explicitWebFallback,
      mixedSourceIntent,
      webFallback: input.webFallback,
    }),
  };
}

function hasExplicitWebFallbackIntent(ask: ChatTurnPlanAsk): boolean {
  const route = ask.semanticRoute;

  return (
    route.web.externalKnowledgeExplicit &&
    route.sourcePolicy.allowDocuments &&
    route.sourcePolicy.allowWeb
  );
}

function hasMixedSourceIntent(ask: ChatTurnPlanAsk): boolean {
  const sourcePolicy = ask.semanticRoute.sourcePolicy;
  const enabledSourceCount = [
    sourcePolicy.allowDocuments,
    sourcePolicy.allowMetrics,
    sourcePolicy.allowWeb,
  ].filter(Boolean).length;

  return (
    ask.semanticRoute.route === ChatSemanticRoute.MIXED ||
    sourcePolicy.allowMixedComposition ||
    enabledSourceCount >= 2
  );
}

function buildExecutionLimitations(input: {
  ask: ChatTurnPlanAsk;
  selectedResponder: ChatTurnResponderKind;
  explicitWebFallback: boolean;
  mixedSourceIntent: boolean;
  webFallback: DocumentsWebFallbackDiagnostics | null;
}): string[] {
  const limitations: string[] = [];
  const route = input.ask.semanticRoute;
  const mixedHandledByDocumentsWebFallback =
    Boolean(input.webFallback) && isDocumentsWebFallbackRoute(input.ask);

  if (input.mixedSourceIntent && !mixedHandledByDocumentsWebFallback) {
    limitations.push('mixed_source_execution_not_implemented');
  }

  if (input.webFallback?.action === 'failed') {
    limitations.push('web_fallback_execution_failed');
  } else if (
    !input.webFallback &&
    (input.explicitWebFallback || route.sourcePolicy.allowWebFallback)
  ) {
    limitations.push('web_fallback_execution_not_implemented');
  }

  if (
    route.web.freshnessRequired &&
    input.selectedResponder !== ChatTurnResponderKind.WEB_SEARCH &&
    input.webFallback?.action !== 'executed'
  ) {
    limitations.push('freshness_followup_not_executed');
  }

  if (
    route.route === ChatSemanticRoute.DOCUMENTS &&
    input.selectedResponder !== ChatTurnResponderKind.DOCUMENTS
  ) {
    limitations.push('semantic_documents_route_not_selected_by_runtime');
  }

  if (
    route.route === ChatSemanticRoute.MIXED &&
    input.selectedResponder === input.ask.responder
  ) {
    limitations.push('mixed_route_fell_back_to_classifier_responder');
  }

  return limitations;
}
