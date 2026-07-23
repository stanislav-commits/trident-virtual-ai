import { Injectable } from '@nestjs/common';
import { DocumentDocClass } from '../../documents/enums/document-doc-class.enum';
import { DocumentRetrievalQuestionType } from '../../documents/enums/document-retrieval-question-type.enum';
import { ChatLlmService } from '../chat-llm.service';
import { ChatMetricsAskTimeMode } from '../planning/chat-metrics-ask-time-mode.enum';
import { parseJsonObject } from '../planning/chat-turn-json.utils';
import {
  ChatSemanticDocumentComponent,
  ChatSemanticDocumentCompositionMode,
  ChatSemanticDocumentsRoute,
  ChatSemanticMetricsRoute,
  ChatSemanticRoute,
  ChatSemanticRouteDecision,
  ChatSemanticRouterInput,
  ChatSemanticSourcePolicy,
  ChatSemanticWebRoute,
} from './chat-semantic-router.types';
import { extractDocumentTitleHint } from './chat-document-title-hints';
import {
  normalizeDocumentAnswerLanguage,
  normalizeDocumentLanguageHint,
  normalizeDocumentRetrievalQuery,
} from './chat-document-retrieval-query';

const SUPPORTED_DOCUMENT_CLASSES = Object.values(DocumentDocClass);
const SUPPORTED_DOCUMENT_QUESTION_TYPES = Object.values(
  DocumentRetrievalQuestionType,
);
const SUPPORTED_METRICS_TIME_MODES = Object.values(ChatMetricsAskTimeMode);
const SUPPORTED_DOCUMENT_COMPOSITION_MODES: ChatSemanticDocumentCompositionMode[] =
  [
    'synthesize',
    'compare',
    'checklist',
    'procedure',
    'conflicts',
    'summarize_by_source',
  ];
const MAX_DOCUMENT_COMPOSITE_COMPONENTS = 3;

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
        maxTokens: 1100,
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
      '- documents: ship-specific manuals, onboard procedures, regulations, troubleshooting, equipment references, or knowledge likely found in uploaded ship documents. Use documents for document-only composite asks too. (Maintenance TASK status → route pms; certificate/compliance STATUS → route compliance; these are NOT documents.)',
      '- metrics: current/live telemetry, point-in-time readings, trends, ranges, operational measurements, vessel state from sensors. ALSO route to METRICS for all of the following — even if a manual might be involved in the answer, METRICS owns the primary route and may consult manuals via its own internal tools: telemetry-event questions (refueling/bunkering visible as a tank-level jump, engine start, sudden counter step, alarm trip, threshold crossing); voyage / sailing / GPS-track / distance / position questions ("where did we sail / how many voyages / where are we / how far did we go"); fuel and energy consumption questions ("how much did we consume / fuel per nm / kWh used"); running-hours / utilization / operating-hours questions ("how many hours did Y run"); is-X-normal / is-it-in-spec questions ("is this normal / within spec / overheating"); efficiency / averages-while-state questions ("average kW at anchor / utilization %"); active-alarms / fault-codes / threshold-crossings ("are there alarms / when did X exceed Y"); equipment-on-state ("is Y running / when did Z last stop"). ALSO ROUTE TO METRICS any equipment-specific manual lookup (oil change interval / coolant interval / service interval / fault code meaning / part numbers / consumables / rated value / operating range / how to replace X) when the question names a specific brand / model / asset on this vessel — METRICS has the best ship-manual access via its own RAGFlow tool. Only route to DOCUMENTS for formal procedures, regulations, or generic ship-operations procedures. ALSO ROUTE TO METRICS onboard INVENTORY / SPARES / PARTS / CONSUMABLES questions — "do we have X in stock / how many spares / where is part Y / what filters/parts do we have for Z / are the parts for this service onboard" — METRICS owns the live inventory tool (these are NOT a PMS-task question even when they name equipment). Route maintenance TASK / PMS register questions (overdue, due, next service, task status, maintenance history) to "pms", and certificate/compliance STATUS questions (validity, expiry, surveys, missing certs) to "compliance", not documents. The metrics responder has its OWN bridge to ship manuals (RAGFlow), so a question that mixes telemetry + manual stays on METRICS unless it is PURELY a formal procedure / regulation lookup. Sensor-observable events are NOT maintenance tasks — route them to metrics; only the planned-maintenance register belongs on pms. ALSO ROUTE TO METRICS whole-vessel READINESS / HEALTH / RISK synthesis questions — "are we ready for charter/departure/survey", "top technical risks today", "overall condition of the yacht", "what would a surveyor find", "health check", "готовы ли мы к чартеру/выходу", "что не в порядке" — METRICS owns the cross-domain sweep (live alarms + overdue maintenance + compliance status + inventory + telemetry reserves in one ranked answer); these are CURRENT-STATE assessments of THIS vessel, NOT a documents/procedure checklist, even when the user words it as "what needs to be done before X". ALSO ROUTE TO METRICS any WRITE/ACTION request on the maintenance register or hours journal: CREATE/add a task ("создай задачу", "add a task to do X"), MARK a task done/completed ("отметь задачу выполненной", "mark the fire drill as done", "мы провели учения — отметь"), LOG a running-hours reading ("запиши моточасы генератора 1046", "log 1046 h on the port genset"), metric WATCHES ("следи за баком 5P, скажи когда меньше 15%", "watch the coolant temp and alert me above 90", "перестань следить за X", "what are you watching"), and DEFECT/failure records ("запиши дефект: порвался ремень", "какие поломки повторяются", "what was the cause last time", "дефект устранён — закрой") — METRICS owns the confirmation-gated write tools (create_maintenance_task / complete_maintenance_task / log_hours_reading / create_metric_watch / remove_metric_watch / log_defect / close_defect) and the defect register (find_defects); the pms route is READ-ONLY (status/history) and cannot write anything.',
      '- pms: the vessel\'s PLANNED-MAINTENANCE register (the Tasks module), which is the LIVE source of truth for maintenance status. Route here for maintenance TASK / work-order questions: what is overdue, what needs attention, what is due soon or upcoming, when a task is next due (by calendar date OR running hours), current task status, what was last done and when, planned vs completed maintenance, maintenance/service history, and task lists for a given piece of equipment. Examples: "what maintenance is overdue", "what needs attention", "when is the next service for the watermaker", "show upcoming/planned maintenance", "maintenance history for the port gearbox", "current PMS status of the main engine". This is STRUCTURED, current register data — NEVER answer maintenance status from documents (uploaded PMS snapshots are stale), NOT a manufacturer manual lookup, and NOT live sensor telemetry. Disambiguation: a manufacturer SERVICE INTERVAL or how-to from the manual is metrics/manual; a raw RUNNING-HOURS sensor reading ("how many hours has X run") is metrics; but the maintenance TASK itself (its due/overdue status, schedule, completion, history) is pms even when tracked by running hours.',
      '- compliance: the vessel\'s COMPLIANCE / DOC-CONTROL register (the Compliance Docs module) — the LIVE source of truth for the STATUS and presence of ALL statutory and controlled documents, not only certificates. It covers statutory certificates, equipment servicing records (e.g. LSA/FFA), equipment type approvals, crew/personnel certificates, insurance, required plans, record books, survey reports, agreements, and legal documents — organised by section (Registration & Flag, Classification, SOLAS, GMDSS, Loadline, MARPOL, ISM/ISPS/MLC, Insurance, Crew STCW, etc.). Route here for questions about what is on file / valid / expiring / expired / missing / due for survey, expiry & issue dates, certificate or document numbers, issuers, survey windows and renewal cycles, and overall compliance status. Examples: "which certificates are expiring", "is the Document of Compliance valid", "what compliance documents are missing", "do we have the Garbage Management Plan on file", "survey window for the safety equipment certificate", "is our MLC certificate in date". This is STRUCTURED current register data — NEVER answer document STATUS from uploaded copies (they are stale). Note: the regulation/standard TEXT behind a requirement, equipment manuals, and rules/regs PUBLICATIONS are documents/metrics (publications belong to the Platform Publications library, NOT compliance); only the register STATUS / validity / presence is compliance.',
      '- files: the user wants the actual DOCUMENT FILE itself — to open, view, download, or be handed the document/manual/plan/drawing — rather than an answer composed from its content. The word "original" is NOT required: "give me the manual", "show me the document", "open the plan" all qualify equally. Route here for "show me the General Arrangement plan", "open the watermaker manual", "give me the fire control drawing", "send me the wiring diagram file", "where is the stability booklet", "give me the manual/document/plan/drawing for X", "open / show / send me <document name>". This is the ONLY route that reaches vessel plans & drawings (stored as files, not parsed). Key distinction: if the user wants a FACT/answer drawn FROM a document ("what does the manual say about…", "what is the oil change interval") → documents/metrics; if the user wants the FILE/document in hand (open/view/download or "give me the X manual|plan|document|drawing") → files. When the user says show/open/give/send/download or names a document/manual/plan/drawing to be handed over, prefer files.',
      '- web: explicit public/external/current knowledge, latest public guidance, or information clearly outside onboard documents.',
      '- mixed: more than one source type is needed, such as current metric state plus manual requirement, or ship document plus public/current guidance. Do not use mixed for document-only composites.',
      '- unclear: the source cannot be selected safely or required context is missing.',
      'Document classes are only manual, historical_procedure, certificate, regulation.',
      'Document class meanings:',
      '- manual: equipment manuals, operation, maintenance, troubleshooting, alarms/faults, spare parts, and technical specifications.',
      '- regulation: regulations, SOPs, formal onboard procedures, checklists, compliance procedures, emergency procedures, required actions, and management-company fleet circulars / notices (standing instructions issued by the vessel\'s management company).',
      '- certificate: certificates, validity, issuer, class/approval, vessel/equipment coverage, and compliance status.',
      '- historical_procedure: historical or planned procedure/PMS/maintenance records, including when maintenance work was done, when maintenance work is due, completed/planned procedure history, status, and timeline.',
      'Document question types are equipment_reference, step_by_step_procedure, historical_case, compliance_or_certificate, multi_document_compare, troubleshooting.',
      'Use equipment_reference for equipment-specific operation, maintenance, removal, replacement, repair, service, cleaning, adjustment, inspection, or technical how-to asks that should come from manuals.',
      'Use step_by_step_procedure only for formal SOP, regulatory, checklist, emergency, compliance, or required-action instructions. Do not treat every "how to" question as a formal procedure.',
      'Procedure intent policy:',
      '- Formal procedure instructions, SOPs, checklists, required actions, and emergency procedure asks are step_by_step_procedure with regulation as the primary class; include manual when equipment-specific.',
      '- Equipment maintenance/removal/replacement/repair/service/cleaning instructions are equipment_reference with manual as the primary class unless the user clearly asks for formal rules, SOP, checklist, compliance, or emergency actions.',
      '- Maintenance/PMS task records, schedules, due dates, overdue/upcoming work, status, planned vs completed work, and maintenance history are route "pms" (the live Tasks register) — NOT documents and NOT historical_procedure (uploaded PMS document snapshots are stale and must not drive maintenance-status answers).',
      '- PMS/current maintenance record asks are route "pms": due or overdue work, upcoming tasks, next maintenance, scheduled or planned maintenance, next service, current task status, responsible person, performed by, work scope, task references, planned or completed maintenance, and maintenance history. Use pms for these even when running hours are mentioned, because the maintenance register tracks due-by-hours itself.',
      '- Compliance / doc-control STATUS asks are route "compliance" (the live Compliance register), NOT documents: validity/expiry of any statutory or controlled document, which are valid/expiring/expired/missing, document/certificate numbers and issuers, surveys and survey windows, renewal cycles, presence of required plans/publications/records, and registration/permits/approvals status. Route the regulation TEXT behind a requirement to documents/publication, but the document STATUS itself to compliance.',
      '- Do not turn PMS/current/history asks into manufacturer manual schedule asks just because they mention maintenance, service, due dates, hours, status, responsibility, or work scope.',
      '- Use manual/equipment_reference for manufacturer or manual instructions: how to perform, how to replace, step-by-step instructions, manufacturer service instructions, operation instructions, technical specifications, or troubleshooting from a manual.',
      '- Do not use historical_case for formal instructions, SOPs, checklists, or required-action questions.',
      '- For multi_document_compare, include all semantically relevant document classes and set multiDocumentLikely true instead of collapsing early to one class.',
      'Document-only composite policy:',
      '- Keep document-only composite asks on route "documents", not route "mixed".',
      '- Set documents.mode to "composite" only when the ask has clearly separate document information needs, named document/source groups, comparisons, conflicts, or synthesis across document classes.',
      '- Use documents.mode "single" for ordinary single-topic document questions, even if they are long.',
      '- For composite mode, provide 2 components by default and at most 3 when clearly necessary.',
      '- Each component must be a focused document question with its own retrievalQuery, questionType, candidateDocClasses, documentTitleHint, requireDocumentTitleMatch, and languageHint.',
      '- Preserve named document titles exactly in the matching component. Do not move title text into retrievalQuery.',
      '- Use compositionMode "compare" for comparisons, "conflicts" for differences/conflicts, "procedure" for combined procedures, "checklist" for checklist answers, "summarize_by_source" for source-by-source summaries, and "synthesize" otherwise.',
      'Document title hint policy:',
      '- If the ask contains an explicit filename, quoted document title, or strong title-like phrase such as a named manual, approval, certificate, SOP, checklist, plan, or procedure, copy that exact title span to documents.documentTitleHint.',
      '- If there is no clear title or filename mention, set documents.documentTitleHint to null. Do not invent document names.',
      'Document retrieval-query policy:',
      '- User questions may be in any language.',
      '- Set documents.answerLanguage to the user-facing answer language, such as "en", "uk", "es", "it", or a short language name when needed.',
      '- For document retrieval only, set documents.retrievalQuery to a concise English search query when the user question is non-English or would benefit from normalization for an English-heavy corpus.',
      '- For English questions, documents.retrievalQuery may be the same as the ask or a concise normalized equivalent.',
      '- Preserve technical terms, acronyms, model numbers, vessel/system names, and document titles exactly.',
      '- Do not broaden the retrievalQuery beyond the user intent, and do not invent missing context.',
      '- Do not translate quoted document titles or filename-like strings.',
      '- ALL hint arrays (equipmentOrSystemHints, manufacturerHints, modelHints, contentFocusHints) MUST be in ENGLISH regardless of the question language — they are matched literally against an English-language document corpus, and non-English hints filter every candidate out — always translate the hint to English (e.g. write "safety precautions", "filter removal", "fuel bleeding"), never leave it in the original question language.',
      '- Keep documents.documentTitleHint separate from documents.retrievalQuery. Do not use retrievalQuery to replace a title hint.',
      '- documents.languageHint is optional document metadata language, not the user answer language; leave it null unless the user explicitly asks for documents in a particular stored document language.',
      '- When setting documents.languageHint, use the exact document-language wording from the ask or retrievalQuery rather than an inferred ISO code.',
      'If a ship context exists and the ask likely refers to onboard/manual knowledge, prefer documents over generic web.',
      'Do not use web as a fallback for weak or missing document evidence; fallback policy is a later orchestration concern.',
      'If the ask needs ship documents but no shipId is available, route unclear and require clarification.',
      'For metrics, use timeMode snapshot for current/live readings, point_in_time for a single historical moment, and range for trend/range requests.',
      'Return only raw JSON with this exact shape:',
      '{"route":"documents|metrics|pms|compliance|files|web|mixed|unclear","confidence":0.0,"requiresClarification":false,"clarificationQuestion":null,"sourcePolicy":{"allowDocuments":true,"allowMetrics":false,"allowWeb":false,"allowWebFallback":false,"allowMixedComposition":false},"documents":{"mode":"single|composite","questionType":"equipment_reference|step_by_step_procedure|historical_case|compliance_or_certificate|multi_document_compare|troubleshooting|null","candidateDocClasses":["manual"],"equipmentOrSystemHints":[],"manufacturerHints":[],"modelHints":[],"contentFocusHints":[],"documentTitleHint":null,"retrievalQuery":null,"answerLanguage":null,"languageHint":null,"multiDocumentLikely":false,"components":[{"id":"part-a","label":"short source label","question":"focused subquestion","retrievalQuery":null,"questionType":"equipment_reference|step_by_step_procedure|historical_case|compliance_or_certificate|multi_document_compare|troubleshooting|null","candidateDocClasses":["manual"],"documentTitleHint":null,"requireDocumentTitleMatch":false,"languageHint":null}],"compositionMode":"synthesize|compare|checklist|procedure|conflicts|summarize_by_source|null"},"metrics":{"timeMode":"snapshot|point_in_time|range|null","timestamp":null,"rangeStart":null,"rangeEnd":null},"web":{"externalKnowledgeExplicit":false,"freshnessRequired":false},"internalDebugNote":"short source-policy note"}',
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

    const documents = this.parseDocumentsRoute(
      entry.documents,
      input.shipId,
      input.question,
    );
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
      documents: this.buildDefaultDocumentsRoute(input.shipId, input.question),
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
    question: string,
  ): ChatSemanticDocumentsRoute {
    if (!value || typeof value !== 'object') {
      return this.buildDefaultDocumentsRoute(shipId, question);
    }

    const entry = value as Record<string, unknown>;
    const parsedQuestionType =
      typeof entry.questionType === 'string' &&
      SUPPORTED_DOCUMENT_QUESTION_TYPES.includes(
        entry.questionType as DocumentRetrievalQuestionType,
      )
        ? (entry.questionType as DocumentRetrievalQuestionType)
        : null;
    const candidateDocClasses = this.parseDocumentClasses(
      entry.candidateDocClasses,
    );
    const documentTitleHint =
      this.parseNullableText(entry.documentTitleHint) ??
      extractDocumentTitleHint(question);
    const retrievalQuery = normalizeDocumentRetrievalQuery({
      originalQuestion: question,
      retrievalQuery: entry.retrievalQuery,
      documentTitleHint,
    });
    const answerLanguage = normalizeDocumentAnswerLanguage(entry.answerLanguage);
    const components = this.parseDocumentComponents(
      entry.components,
      answerLanguage,
    );

    return {
      shipId,
      mode:
        entry.mode === 'composite' || components.length >= 2
          ? 'composite'
          : 'single',
      questionType: parsedQuestionType,
      candidateDocClasses,
      equipmentOrSystemHints: this.parseStringList(entry.equipmentOrSystemHints),
      manufacturerHints: this.parseStringList(entry.manufacturerHints),
      modelHints: this.parseStringList(entry.modelHints),
      contentFocusHints: this.parseStringList(entry.contentFocusHints),
      documentTitleHint,
      retrievalQuery,
      answerLanguage,
      languageHint: normalizeDocumentLanguageHint({
        originalQuestion: question,
        retrievalQuery,
        languageHint: entry.languageHint,
        answerLanguage,
        documentTitleHint,
      }),
      multiDocumentLikely: entry.multiDocumentLikely === true,
      components,
      compositionMode: this.parseDocumentCompositionMode(entry.compositionMode),
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

  private parseDocumentComponents(
    value: unknown,
    answerLanguage: string | null,
  ): ChatSemanticDocumentComponent[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const components: ChatSemanticDocumentComponent[] = [];
    const seenIds = new Set<string>();

    for (const item of value) {
      if (components.length >= MAX_DOCUMENT_COMPOSITE_COMPONENTS) {
        break;
      }

      if (!item || typeof item !== 'object') {
        continue;
      }

      const entry = item as Record<string, unknown>;
      const question = this.parseNullableText(entry.question);

      if (!question || question.length < 6) {
        continue;
      }

      const id = this.buildDocumentComponentId(entry.id, components.length, seenIds);
      const label = this.parseNullableText(entry.label);
      const documentTitleHint =
        this.parseNullableText(entry.documentTitleHint) ??
        extractDocumentTitleHint(question);
      const retrievalQuery = normalizeDocumentRetrievalQuery({
        originalQuestion: question,
        retrievalQuery: entry.retrievalQuery,
        documentTitleHint,
      });

      components.push({
        id,
        label,
        question,
        retrievalQuery,
        questionType: this.parseDocumentQuestionType(entry.questionType),
        candidateDocClasses: this.parseDocumentClasses(entry.candidateDocClasses),
        documentTitleHint,
        requireDocumentTitleMatch: entry.requireDocumentTitleMatch === true,
        languageHint: normalizeDocumentLanguageHint({
          originalQuestion: question,
          retrievalQuery,
          languageHint: entry.languageHint,
          answerLanguage,
          documentTitleHint,
        }),
      });
    }

    return components;
  }

  private buildDocumentComponentId(
    value: unknown,
    index: number,
    seenIds: Set<string>,
  ): string {
    const parsed = this.parseNullableText(value);
    const normalized =
      parsed
        ?.toLocaleLowerCase()
        .replace(/[^a-z0-9_-]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .slice(0, 40) || `component-${index + 1}`;
    let candidate = normalized;
    let suffix = 2;

    while (seenIds.has(candidate)) {
      candidate = `${normalized}-${suffix}`;
      suffix += 1;
    }

    seenIds.add(candidate);
    return candidate;
  }

  private parseDocumentQuestionType(
    value: unknown,
  ): DocumentRetrievalQuestionType | null {
    return typeof value === 'string' &&
      SUPPORTED_DOCUMENT_QUESTION_TYPES.includes(
        value as DocumentRetrievalQuestionType,
      )
      ? (value as DocumentRetrievalQuestionType)
      : null;
  }

  private parseDocumentCompositionMode(
    value: unknown,
  ): ChatSemanticDocumentCompositionMode | null {
    return typeof value === 'string' &&
      SUPPORTED_DOCUMENT_COMPOSITION_MODES.includes(
        value as ChatSemanticDocumentCompositionMode,
      )
      ? (value as ChatSemanticDocumentCompositionMode)
      : null;
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
    question = '',
  ): ChatSemanticDocumentsRoute {
    return {
      shipId,
      mode: 'single',
      questionType: null,
      candidateDocClasses: [],
      equipmentOrSystemHints: [],
      manufacturerHints: [],
      modelHints: [],
      contentFocusHints: [],
      documentTitleHint: extractDocumentTitleHint(question),
      retrievalQuery: null,
      answerLanguage: null,
      languageHint: null,
      multiDocumentLikely: false,
      components: [],
      compositionMode: null,
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
      documents.contentFocusHints.length > 0 ||
      documents.documentTitleHint !== null ||
      documents.components.length > 0 ||
      documents.mode === 'composite'
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
