import { Injectable } from '@nestjs/common';
import { DocumentDocClass } from '../../documents/enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../../documents/enums/document-retrieval-question-type.enum';
import { ChatLlmService } from '../chat-llm.service';
import { ChatMetricsAskTimeMode } from '../planning/chat-metrics-ask-time-mode.enum';
import { parseJsonObject } from '../planning/chat-turn-json.utils';
import {
  ChatSemanticDocumentsRoute,
  ChatSemanticMetricsRoute,
  ChatSemanticRoute,
  ChatSemanticRouteDecision,
  ChatSemanticRouterInput,
  ChatSemanticSourcePolicy,
  ChatSemanticWebRoute,
} from './chat-semantic-router.types';

const SUPPORTED_DOCUMENT_CLASSES = Object.values(DocumentDocClass);
const SUPPORTED_DOCUMENT_QUESTION_TYPES = Object.values(
  DocumentRetrievalQuestionType,
);
const SUPPORTED_METRICS_TIME_MODES = Object.values(ChatMetricsAskTimeMode);

@Injectable()
export class ChatSemanticRouterService {
  constructor(private readonly chatLlmService: ChatLlmService) {}

  async route(input: ChatSemanticRouterInput): Promise<ChatSemanticRouteDecision> {
    const question = input.question.trim();

    if (!question) {
      return this.buildFallbackDecision(input, 'The router received an empty ask.');
    }

    const rawResult = await this.completeRoutingPrompt(input);
    const parsed = this.parseDecision(rawResult, input);

    if (parsed) {
      return parsed;
    }

    return this.buildFallbackDecision(
      input,
      'The semantic router could not parse a valid routing decision.',
    );
  }

  private async completeRoutingPrompt(
    input: ChatSemanticRouterInput,
  ): Promise<string | null> {
    try {
      return await this.chatLlmService.completeText({
        systemPrompt: this.buildSystemPrompt(),
        userPrompt: this.buildUserPrompt(input),
        temperature: 0,
        maxTokens: 520,
      });
    } catch {
      return null;
    }
  }

  private buildSystemPrompt(): string {
    return [
      'You are the semantic source router for Trident chat-v2.',
      'Classify one standalone ask into the most appropriate source route.',
      'Do not answer the user.',
      'Do not call tools.',
      'Do not expose chain-of-thought.',
      'Use semantic intent, active ship context, and source policy. Do not rely on brittle keyword matching.',
      'Primary routes:',
      '- documents: ship-specific manuals, onboard procedures, historical procedures, certificates, regulations, troubleshooting, equipment references, or knowledge likely found in uploaded ship documents.',
      '- metrics: current/live telemetry, point-in-time readings, trends, ranges, operational measurements, vessel state from sensors.',
      '- web: explicit public/external/current knowledge, latest public guidance, or information clearly outside onboard documents.',
      '- mixed: more than one source is needed, such as current metric state plus manual requirement, or ship document plus public/current guidance.',
      '- unclear: the source cannot be selected safely or required context is missing.',
      'Document classes are only manual, historical_procedure, certificate, regulation.',
      'Document class meanings:',
      '- manual: equipment manuals, operation, maintenance, troubleshooting, alarms/faults, spare parts, and technical specifications.',
      '- regulation: regulations, SOPs, formal onboard procedures, checklists, compliance procedures, emergency procedures, and required actions.',
      '- certificate: certificates, validity, issuer, class/approval, vessel/equipment coverage, and compliance status.',
      '- historical_procedure: historical or planned procedure records, including when something was done, when it is due, completed/planned procedure history, status, and timeline.',
      'Document question types are equipment_reference, step_by_step_procedure, historical_case, compliance_or_certificate, multi_document_compare, troubleshooting.',
      'Procedure intent policy:',
      '- Procedure instructions, SOPs, checklists, required actions, and emergency procedure asks are step_by_step_procedure with regulation as the primary class; include manual when equipment-specific.',
      '- Procedure records, schedules, history, status, due dates, planned work, and completed work are historical_case with historical_procedure as the class.',
      '- Do not use historical_case for formal instructions, SOPs, checklists, or required-action questions.',
      '- For multi_document_compare, include all semantically relevant document classes and set multiDocumentLikely true instead of collapsing early to one class.',
      'If a ship context exists and the ask likely refers to onboard/manual knowledge, prefer documents over generic web.',
      'Do not use web as a fallback for weak or missing document evidence; fallback policy is a later orchestration concern.',
      'If the ask needs ship documents but no shipId is available, route unclear and require clarification.',
      'For metrics, use timeMode snapshot for current/live readings, point_in_time for a single historical moment, and range for trend/range requests.',
      'Return only raw JSON with this exact shape:',
      '{"route":"documents|metrics|web|mixed|unclear","confidence":0.0,"requiresClarification":false,"clarificationQuestion":null,"sourcePolicy":{"allowDocuments":true,"allowMetrics":false,"allowWeb":false,"allowWebFallback":false,"allowMixedComposition":false},"documents":{"questionType":"equipment_reference|step_by_step_procedure|historical_case|compliance_or_certificate|multi_document_compare|troubleshooting|null","candidateDocClasses":["manual"],"equipmentOrSystemHints":[],"manufacturerHints":[],"modelHints":[],"contentFocusHints":[],"languageHint":null,"multiDocumentLikely":false},"metrics":{"timeMode":"snapshot|point_in_time|range|null","timestamp":null,"rangeStart":null,"rangeEnd":null},"web":{"externalKnowledgeExplicit":false,"freshnessRequired":false},"internalDebugNote":"short source-policy note"}',
      'Do not wrap JSON in markdown.',
    ].join('\n');
  }

  private buildUserPrompt(input: ChatSemanticRouterInput): string {
    return [
      `Standalone ask: ${input.question}`,
      `Active shipId: ${input.shipId ?? 'none'}`,
      `Preferred response language: ${input.responseLanguage ?? 'infer if needed'}`,
    ].join('\n');
  }

  private parseDecision(
    rawResult: string | null,
    input: ChatSemanticRouterInput,
  ): ChatSemanticRouteDecision | null {
    const parsed = parseJsonObject(rawResult);

    if (!parsed) {
      return null;
    }

    const entry = parsed as Record<string, unknown>;
    const route = this.parseRoute(entry.route);

    if (!route) {
      return null;
    }

    const confidence = this.parseConfidence(entry.confidence);
    const requiresClarification = entry.requiresClarification === true;
    const clarificationQuestion = this.parseNullableText(
      entry.clarificationQuestion,
    );

    const documents = this.parseDocumentsRoute(entry.documents, input.shipId);
    const metrics = this.parseMetricsRoute(entry.metrics);
    const web = this.parseWebRoute(entry.web);

    return {
      route,
      confidence,
      requiresClarification:
        requiresClarification ||
        (route === ChatSemanticRoute.UNCLEAR && confidence < 0.7),
      clarificationQuestion,
      sourcePolicy: this.parseSourcePolicy(
        entry.sourcePolicy,
        route,
        documents,
        metrics,
        web,
      ),
      documents,
      metrics,
      web,
      internalDebugNote: this.parseNullableText(entry.internalDebugNote) ?? undefined,
    };
  }

  private buildFallbackDecision(
    input: ChatSemanticRouterInput,
    reason: string,
  ): ChatSemanticRouteDecision {
    return {
      route: ChatSemanticRoute.UNCLEAR,
      confidence: 0,
      requiresClarification: true,
      clarificationQuestion:
        'Should I use ship documents, vessel metrics, or public web information for this?',
      sourcePolicy: this.buildSourcePolicy(ChatSemanticRoute.UNCLEAR),
      documents: this.buildDefaultDocumentsRoute(input.shipId),
      metrics: this.buildDefaultMetricsRoute(),
      web: this.buildDefaultWebRoute(),
      internalDebugNote: reason,
    };
  }

  private parseRoute(value: unknown): ChatSemanticRoute | null {
    return typeof value === 'string' &&
      Object.values(ChatSemanticRoute).includes(value as ChatSemanticRoute)
      ? (value as ChatSemanticRoute)
      : null;
  }

  private parseConfidence(value: unknown): number {
    const numberValue =
      typeof value === 'number' ? value : Number.parseFloat(String(value));

    if (!Number.isFinite(numberValue)) {
      return 0;
    }

    return Math.max(0, Math.min(1, numberValue));
  }

  private buildSourcePolicy(route: ChatSemanticRoute): ChatSemanticSourcePolicy {
    return {
      allowDocuments:
        route === ChatSemanticRoute.DOCUMENTS || route === ChatSemanticRoute.MIXED,
      allowMetrics:
        route === ChatSemanticRoute.METRICS || route === ChatSemanticRoute.MIXED,
      allowWeb: route === ChatSemanticRoute.WEB || route === ChatSemanticRoute.MIXED,
      allowWebFallback: false,
      allowMixedComposition: route === ChatSemanticRoute.MIXED,
    };
  }

  private parseSourcePolicy(
    value: unknown,
    route: ChatSemanticRoute,
    documents: ChatSemanticDocumentsRoute,
    metrics: ChatSemanticMetricsRoute,
    web: ChatSemanticWebRoute,
  ): ChatSemanticSourcePolicy {
    if (route !== ChatSemanticRoute.MIXED) {
      return this.buildSourcePolicy(route);
    }

    const parsed =
      value && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : null;
    const allowDocuments =
      parsed?.allowDocuments === true || this.hasDocumentsIntent(documents);
    const allowMetrics =
      parsed?.allowMetrics === true || this.hasMetricsIntent(metrics);
    const allowWeb = parsed?.allowWeb === true || this.hasWebIntent(web);
    const enabledSourceCount = [allowDocuments, allowMetrics, allowWeb].filter(
      Boolean,
    ).length;

    if (enabledSourceCount >= 2) {
      return {
        allowDocuments,
        allowMetrics,
        allowWeb,
        allowWebFallback: false,
        allowMixedComposition: true,
      };
    }

    return {
      allowDocuments: true,
      allowMetrics: true,
      allowWeb: false,
      allowWebFallback: false,
      allowMixedComposition: true,
    };
  }

  private parseDocumentsRoute(
    value: unknown,
    shipId: string | null,
  ): ChatSemanticDocumentsRoute {
    if (!value || typeof value !== 'object') {
      return this.buildDefaultDocumentsRoute(shipId);
    }

    const entry = value as Record<string, unknown>;
    const questionType =
      typeof entry.questionType === 'string' &&
      SUPPORTED_DOCUMENT_QUESTION_TYPES.includes(
        entry.questionType as DocumentRetrievalQuestionType,
      )
        ? (entry.questionType as DocumentRetrievalQuestionType)
        : null;
    const candidateDocClasses = this.parseDocumentClasses(
      entry.candidateDocClasses,
    );

    return {
      shipId,
      questionType,
      candidateDocClasses,
      equipmentOrSystemHints: this.parseStringList(entry.equipmentOrSystemHints),
      manufacturerHints: this.parseStringList(entry.manufacturerHints),
      modelHints: this.parseStringList(entry.modelHints),
      contentFocusHints: this.parseStringList(entry.contentFocusHints),
      languageHint: this.parseNullableText(entry.languageHint),
      multiDocumentLikely: entry.multiDocumentLikely === true,
    };
  }

  private parseMetricsRoute(value: unknown): ChatSemanticMetricsRoute {
    if (!value || typeof value !== 'object') {
      return this.buildDefaultMetricsRoute();
    }

    const entry = value as Record<string, unknown>;
    const timeMode =
      typeof entry.timeMode === 'string' &&
      SUPPORTED_METRICS_TIME_MODES.includes(entry.timeMode as ChatMetricsAskTimeMode)
        ? (entry.timeMode as ChatMetricsAskTimeMode)
        : null;

    return {
      timeMode,
      timestamp: this.parseNullableText(entry.timestamp),
      rangeStart: this.parseNullableText(entry.rangeStart),
      rangeEnd: this.parseNullableText(entry.rangeEnd),
    };
  }

  private parseWebRoute(value: unknown): ChatSemanticWebRoute {
    if (!value || typeof value !== 'object') {
      return this.buildDefaultWebRoute();
    }

    const entry = value as Record<string, unknown>;

    return {
      externalKnowledgeExplicit: entry.externalKnowledgeExplicit === true,
      freshnessRequired: entry.freshnessRequired === true,
    };
  }

  private parseDocumentClasses(value: unknown): DocumentDocClass[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value.filter(
          (entry): entry is DocumentDocClass =>
            typeof entry === 'string' &&
            SUPPORTED_DOCUMENT_CLASSES.includes(entry as DocumentDocClass),
        ),
      ),
    );
  }

  private parseStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter(Boolean),
      ),
    );
  }

  private parseNullableText(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : null;
  }

  private buildDefaultDocumentsRoute(
    shipId: string | null,
  ): ChatSemanticDocumentsRoute {
    return {
      shipId,
      questionType: null,
      candidateDocClasses: [],
      equipmentOrSystemHints: [],
      manufacturerHints: [],
      modelHints: [],
      contentFocusHints: [],
      languageHint: null,
      multiDocumentLikely: false,
    };
  }

  private buildDefaultMetricsRoute(): ChatSemanticMetricsRoute {
    return {
      timeMode: null,
      timestamp: null,
      rangeStart: null,
      rangeEnd: null,
    };
  }

  private buildDefaultWebRoute(): ChatSemanticWebRoute {
    return {
      externalKnowledgeExplicit: false,
      freshnessRequired: false,
    };
  }

  private hasDocumentsIntent(documents: ChatSemanticDocumentsRoute): boolean {
    return (
      documents.questionType !== null ||
      documents.candidateDocClasses.length > 0 ||
      documents.equipmentOrSystemHints.length > 0 ||
      documents.manufacturerHints.length > 0 ||
      documents.modelHints.length > 0 ||
      documents.contentFocusHints.length > 0
    );
  }

  private hasMetricsIntent(metrics: ChatSemanticMetricsRoute): boolean {
    return (
      metrics.timeMode !== null ||
      metrics.timestamp !== null ||
      metrics.rangeStart !== null ||
      metrics.rangeEnd !== null
    );
  }

  private hasWebIntent(web: ChatSemanticWebRoute): boolean {
    return web.externalKnowledgeExplicit || web.freshnessRequired;
  }
}
