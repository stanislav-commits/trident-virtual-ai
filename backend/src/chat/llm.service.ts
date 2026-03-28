import {
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import OpenAI from 'openai';
import { SystemPromptService } from '../system-prompt/system-prompt.service';
import { IMMUTABLE_CHAT_CORE_SYSTEM_PROMPT } from './chat-core-system-prompt.constants';
import {
  ChatQueryPlan,
  ChatQueryPlannerService,
} from './chat-query-planner.service';

export interface LLMContext {
  userQuery: string;
  previousUserQuery?: string;
  resolvedSubjectQuery?: string;
  compareBySource?: boolean;
  sourceComparisonTitles?: string[];
  citations?: Array<{
    snippet: string;
    sourceTitle: string;
    sourceCategory?: string;
    pageNumber?: number;
  }>;
  shipName?: string;
  telemetry?: Record<string, unknown>;
  telemetryPrefiltered?: boolean;
  telemetryMatchMode?: 'none' | 'sample' | 'exact' | 'direct' | 'related';
  noDocumentation?: boolean;
  chatHistory?: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
  }>;
}

interface HourTelemetryEntry {
  label: string;
  hours: number;
}

interface DocumentedIntervalEntry {
  intervalHours: number;
  sourceIndex: number;
  sourceTitle: string;
  pageNumber?: number;
}

interface ExplicitNextDueEntry {
  nextDueHours: number;
  sourceIndex: number;
  sourceTitle: string;
  pageNumber?: number;
}

type QueryIntent =
  | 'telemetry_list'
  | 'telemetry_status'
  | 'manual_specification'
  | 'maintenance_due_now'
  | 'next_due_calculation'
  | 'parts_fluids_consumables'
  | 'maintenance_procedure'
  | 'troubleshooting'
  | 'fragment_reference'
  | 'general';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxTokens: number;
  private readonly queryPlanner: ChatQueryPlannerService;

  constructor(
    @Optional() private readonly systemPromptService?: SystemPromptService,
    @Optional() queryPlanner?: ChatQueryPlannerService,
  ) {
    this.queryPlanner = queryPlanner ?? new ChatQueryPlannerService();

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    this.client = new OpenAI({ apiKey });
    this.model = process.env.LLM_MODEL || 'gpt-4o-mini';
    this.temperature = parseFloat(process.env.LLM_TEMPERATURE || '0.3');
    this.maxTokens = parseInt(process.env.LLM_MAX_TOKENS || '1500', 10);
  }

  async generateResponse(context: LLMContext): Promise<string> {
    try {
      // Chat generation intentionally uses an immutable core prompt so
      // admin-edited prompt text cannot change routing or evidence handling.
      const systemPrompt = this.buildSystemPrompt(
        context.shipName,
        IMMUTABLE_CHAT_CORE_SYSTEM_PROMPT,
      );
      const userPrompt = this.buildUserPrompt(context);

      // Build messages array with optional chat history
      const messages: Array<{
        role: 'user' | 'assistant' | 'system';
        content: string;
      }> = [{ role: 'system', content: systemPrompt }];

      // Add previous chat history — skip for fragment inputs to avoid context bleed
      const intent = this.classifyQueryIntent(context.userQuery);
      if (
        intent !== 'fragment_reference' &&
        context.chatHistory &&
        context.chatHistory.length > 0
      ) {
        const historyMessages = [...context.chatHistory];
        const lastHistoryMessage = historyMessages[historyMessages.length - 1];
        if (
          lastHistoryMessage?.role === 'user' &&
          lastHistoryMessage.content.trim() === context.userQuery.trim()
        ) {
          historyMessages.pop();
        }

        messages.push(...historyMessages.map((msg) => ({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content,
        })));
      }

      // Add current user query
      messages.push({ role: 'user', content: userPrompt });

      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: this.temperature,
        max_tokens: this.maxTokens,
        messages,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from LLM');
      }

      return content.trim();
    } catch (err) {
      throw new ServiceUnavailableException(
        `LLM generation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async generateTitle(userMessage: string): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        temperature: 0.5,
        max_tokens: 20,
        messages: [
          {
            role: 'system',
            content:
              'Generate a very short chat title (3-6 words, no quotes) summarizing the user message. Respond with ONLY the title, nothing else.',
          },
          { role: 'user', content: userMessage },
        ],
      });

      const title = response.choices[0]?.message?.content?.trim();
      return title || 'New Chat';
    } catch {
      return 'New Chat';
    }
  }

  private async getSystemPromptTemplate(): Promise<string> {
    if (!this.systemPromptService) {
      return IMMUTABLE_CHAT_CORE_SYSTEM_PROMPT;
    }

    try {
      return await this.systemPromptService.getPromptTemplate();
    } catch (error) {
      this.logger.warn(
        `Failed to load editable system prompt, using default template instead: ${error instanceof Error ? error.message : String(error)}`,
      );
      return IMMUTABLE_CHAT_CORE_SYSTEM_PROMPT;
    }
  }

  private buildSystemPrompt(
    shipName?: string,
    template = IMMUTABLE_CHAT_CORE_SYSTEM_PROMPT,
  ): string {
    const normalizedShipName = shipName?.trim() ?? '';

    return template
      .replaceAll('{{shipNameWithParens}}', normalizedShipName ? ` (${normalizedShipName})` : '')
      .replaceAll('{{shipName}}', normalizedShipName);
  }

  private buildUserPrompt(context: LLMContext): string {
    const queryPlan = this.queryPlanner.planQuery(
      context.userQuery,
      context.resolvedSubjectQuery,
    );
    const intent = queryPlan.primaryIntent;
    let prompt =
      `Detected intent: ${intent}\n` +
      `Question: ${context.userQuery}\n` +
      this.buildOperationalContextPrompt(queryPlan);
    prompt += this.buildPlannerSpecificGuidance(queryPlan, context);

    if (context.previousUserQuery) {
      prompt +=
        `Follow-up context:\n` +
        `Previous user question: ${context.previousUserQuery}\n` +
        `Interpret the current question as continuing that subject unless the current question clearly changes topic.\n\n`;
    }

    if (
      context.resolvedSubjectQuery &&
      context.resolvedSubjectQuery.trim() &&
      context.resolvedSubjectQuery.trim() !== context.userQuery.trim()
    ) {
      prompt += `Resolved subject for retrieval: ${context.resolvedSubjectQuery}\n\n`;
    }

    if (context.compareBySource && (context.sourceComparisonTitles?.length ?? 0) > 1) {
      prompt +=
        'Important: The retrieved context contains materially different documented facts for the same subject across multiple sources. ' +
        `Answer separately by source for these manuals: ${context.sourceComparisonTitles?.join(', ')}. ` +
        'For each source, state only the facts documented in that source. Do not merge conflicting values into one combined instruction.\n\n';
    }

    if (this.isDirectLookupSubjectQuery(context.userQuery)) {
      prompt +=
        'Important: The user input looks like a concrete task, service, component, or maintenance item title. ' +
        'Treat it as a lookup request for that named item. ' +
        'Return the most relevant documented details for that item without asking for clarification unless multiple equally plausible matches remain.\n\n';
    }

    if (this.hasExplicitSourceRequest(context.userQuery)) {
      prompt +=
        'Important: The user explicitly requested information according to a named source. ' +
        'If matching citations from that named manual, handbook, guide, or document are present, answer from that source only and ignore unrelated manuals.\n\n';
    }

    if (
      intent === 'telemetry_list' &&
      context.telemetry &&
      Object.keys(context.telemetry).length > 0
    ) {
      prompt +=
        'Important: The user is asking for a list or sample of currently active telemetry metrics. ' +
        'Answer only from the provided telemetry list. ' +
        'Do not replace it with documentation excerpts or say the metrics are unavailable when telemetry is present. ' +
        'If the user requested a count, return up to that many telemetry items with their latest values. ' +
        'If the query narrows the list to a subject such as fuel tanks, generators, or batteries, only use telemetry items that match that subject.\n\n';
    }

    if (
      intent === 'telemetry_status' &&
      context.telemetryPrefiltered &&
      context.telemetry &&
      Object.keys(context.telemetry).length > 0
    ) {
      prompt +=
        'Important: This is a current telemetry/status question. ' +
        'Answer from the matched telemetry first when one telemetry item clearly matches the asked metric. ' +
        'Use documentation only as supporting context, not as a replacement for the current reading.\n\n';
    }

    if (context.telemetryMatchMode === 'exact') {
      prompt +=
        'Important: The telemetry below contains an exact metric match for the question. ' +
        'State that current metric value directly. ' +
        'Do not say the value is unavailable or only indirectly related when the matched telemetry already provides it. ' +
        'If more than one exact matched reading is listed, report those matched readings explicitly instead of saying telemetry is unavailable.\n\n';
    } else if (context.telemetryMatchMode === 'direct') {
      prompt +=
        'Important: The telemetry below directly measures the requested current reading. ' +
        'Answer from that direct telemetry value first. ' +
        'If multiple direct matched readings are present, list them explicitly before any interpretation.\n\n';
    } else if (context.telemetryMatchMode === 'related') {
      prompt +=
        'Important: The telemetry below is only related supporting telemetry and may not directly measure the exact value asked for. ' +
        'Do not present related telemetry such as temperature or pressure as if it were a direct level or direct reading unless the telemetry label clearly matches.\n\n';
    }

    if (
      this.isTelemetryGuidedDocumentationQuery(context.userQuery) &&
      context.telemetryPrefiltered &&
      context.telemetry &&
      Object.keys(context.telemetry).length > 0
    ) {
      prompt +=
        'Important: This question combines a current telemetry reading with a request for guidance or next actions. ' +
        'First identify the matched current telemetry reading. ' +
        'If the matched telemetry already provides one or more direct readings, state those readings explicitly before any recommendation and do not say the reading is unavailable. ' +
        'Then use the documentation only to determine whether that reading implies a documented action, threshold, recommendation, or next step for the same metric or system. ' +
        'If the documentation does not define an action threshold or recommendation for the matched telemetry reading, say that clearly instead of inventing one.\n\n';
    }

    if (this.hasExactReferenceId(context.userQuery, context.resolvedSubjectQuery)) {
      prompt +=
        'Important: The user is asking about an exact reference ID. ' +
        'Use only the matching reference row plus obvious continuation lines tied to that same row or same page. ' +
        'Do not borrow tasks, spare parts, or part numbers from earlier or later unrelated reference rows in the same snippet. ' +
        'If the user only gives the exact reference ID, treat that as a direct lookup request and summarize the matching row instead of asking what they mean.\n\n';
    }

    if (intent === 'maintenance_procedure' && context.resolvedSubjectQuery) {
      prompt +=
        'Important: The user is asking what to do for the maintenance item already identified in prior context. ' +
        'Prefer the task list or included work items from the matching maintenance schedule row for that subject. ' +
        'If the schedule row lists the task items explicitly, list those scheduled tasks first. ' +
        'Use generic manual procedure text only as supplementary guidance, and label it as general guidance rather than the task list itself. ' +
        'If the citations only show a maintenance schedule row, a spare-parts table, or general part names, do not invent an exact drain, refill, warm-up, or leak-check sequence unless those steps are explicitly documented in the cited manual text. ' +
        'Do not infer oil capacity, fill volume, or consumption from spare-parts quantities, package sizes, or continuation lines such as "20LT", "Quantity: 2", or similar inventory text.\n\n';
    }

    if (
      intent === 'parts_fluids_consumables' &&
      context.resolvedSubjectQuery
    ) {
      prompt +=
        'Important: The user is asking for spare parts or consumables for the maintenance item already identified in prior context. ' +
        'Prefer an explicit spare-parts table or part-number block tied to that same maintenance row or component. ' +
        'If such a list is present, return the full documented spare-parts list for that matching row or component, including all visible spare names, quantities, locations, and part numbers, instead of giving only a partial sample or saying the parts are unavailable.\n\n';
    }

    if (this.wantsExhaustiveTableAnswer(context.userQuery)) {
      prompt +=
        'Important: The user asked for an exhaustive table answer. ' +
        'Continue through the full relevant parts list visible in the citations, merge wrapped lines that clearly belong to the same part row, and do not omit lower rows.\n\n';
    }

    if (
      intent === 'maintenance_due_now' &&
      context.resolvedSubjectQuery &&
      context.telemetry &&
      Object.keys(context.telemetry).length > 0
    ) {
      prompt +=
        'Important: The user is asking for the next upcoming maintenance item for the current asset. ' +
        'If multiple maintenance schedule rows match the same asset, prefer the documented row with the earliest upcoming next-due threshold or date that is still ahead of the current telemetry reading. ' +
        'Do not answer with a later 2000-hour or 3000-hour service if a nearer upcoming 500-hour or 1000-hour service is documented for the same asset. ' +
        'Answer with the documented service or task name exactly as written in the schedule first, then provide the due date or due hours as supporting detail. Do not answer only with the due timing.\n\n';
    }

    if (intent === 'next_due_calculation') {
      prompt +=
        'Important: The user is asking when the maintenance is due. ' +
        'Answer with the documented next-due date, next-due hour threshold, or remaining hours first. ' +
        'You may mention the service name as supporting context, but the primary answer must be the due timing rather than just the service title.\n\n';
    }

    if (
      this.classifyQueryIntent(context.userQuery) ===
        'parts_fluids_consumables' &&
      !this.hasExplicitPartsEvidence(context.citations)
    ) {
      prompt +=
        'Important: The retrieved context does not show an explicit parts table or part-number fields for the asked item. ' +
        'Do not convert maintenance actions into parts. ' +
        'If no explicit spare names, quantities, or part numbers are shown for the asked item, state that the documentation does not list parts for it.\n\n';
    }

    if (
      this.classifyQueryIntent(context.userQuery) ===
        'parts_fluids_consumables' &&
      this.hasExplicitPartsEvidence(context.citations)
    ) {
      prompt +=
        'Important: The retrieved context contains a spare-parts table or part-number fields. ' +
        'Do not answer that spare parts are unavailable. ' +
        'Return the documented spare names first, then quantities, locations, manufacturer part numbers, and supplier part numbers when they are visible.\n\n';
    }

    if (intent === 'fragment_reference') {
      prompt +=
        'Important: The user input is a short label, code, title, or identifier fragment. ' +
        'Do not infer a maintenance answer from it. ' +
        'Ask one short clarifying question about what the user wants to know.\n\n';
    }

    if (context.citations && context.citations.length > 0) {
      prompt += 'Relevant Documentation:\n';
      context.citations.forEach((citation, idx) => {
        const pageInfo = citation.pageNumber
          ? ` (Page ${citation.pageNumber})`
          : '';
        const sourceLabel = this.formatCitationSourceLabel(citation);
        prompt += `[${idx + 1}] ${sourceLabel}${pageInfo}:\n`;
        prompt += `${citation.snippet}\n\n`;
      });
    } else if (context.noDocumentation) {
      prompt +=
        'Note: No matching documentation context was found for this query. ' +
        'If this query relates to maintenance tasks or due service items, do NOT list or invent maintenance items — they are not confirmed by the provided documentation. ' +
        'Use telemetry only if it directly answers the question. ' +
        'If the answer is not supported by the provided context, clearly state that the documentation does not confirm it. ' +
        'Do not speculate. Do not invent source markers when no supporting source was provided.\n\n';
    }

    if (context.noDocumentation && context.telemetryPrefiltered) {
      prompt +=
        'Important: The telemetry below was prefiltered as the closest current metric matches for the question. ' +
        'Prefer these matched telemetry readings when they directly answer the request.\n\n';
    }

    if (context.telemetry && Object.keys(context.telemetry).length > 0) {
      if (this.isTelemetryAggregateCalculationQuery(context.userQuery)) {
        prompt +=
          'Important: The user is asking for a combined total or calculation from multiple current telemetry readings. ' +
          'If the matched telemetry entries form a coherent set such as fuel-tank readings, use all matching entries needed for that total, calculate the combined result explicitly, and state the total in the answer. ' +
          'Do not ask for extra clarification when the matched telemetry already contains the needed tank readings. ' +
          'Do not mix unrelated tanks, fluids, or telemetry subjects into the calculation. ' +
          'If the matched telemetry entries are dedicated tank identifiers such as Fuel Tank 1P, Fuel_Tank_1P, or Water Tank 10S, treat their numeric values as the current tank readings for this calculation even if some noisy metadata or grouping text mentions temperature. ' +
          'Do not refuse the calculation just because a selected tank reading has imperfect descriptive text.\n\n';
      }

      if (this.isLocationTelemetryQuery(context.userQuery)) {
        prompt +=
          'Important: If matched telemetry includes latitude and longitude, treat those coordinates together as the vessel\'s current location. ' +
          'Do not say the location is unavailable when those coordinates are present. ' +
          'If the user asks for a named place, port, or marina and telemetry only gives coordinates, report the coordinates first and clearly say that telemetry alone does not confirm a specific port name.\n\n';
      }

      if (context.telemetryPrefiltered) {
        prompt +=
          'Matched Telemetry:\n' +
          '- The telemetry items below were preselected as the best matches for the current question.\n' +
          '- If one telemetry item clearly matches the asked metric or current reading, answer from that current value directly.\n' +
          '- For guidance questions, use these matched readings before deciding whether the documentation supports any action.\n\n';
      }
      prompt += 'Current Telemetry:\n';
      Object.entries(context.telemetry).forEach(([key, value]) => {
        prompt += `- ${key}: ${value}\n`;
      });
      prompt += '\n';
    }

    const maintenanceGuidance = this.buildMaintenanceCalculationPrompt(
      context,
      queryPlan,
    );
    if (maintenanceGuidance) {
      prompt += maintenanceGuidance;
    }

    return prompt;
  }

  private buildOperationalContextPrompt(queryPlan: ChatQueryPlan): string {
    const now = new Date();
    let prompt = '';

    prompt +=
      `Current operational timestamp (UTC): ${now.toISOString()}\n` +
      `Preferred evidence order: ${queryPlan.sourcePriorities.join(' -> ')}\n`;

    if (queryPlan.secondaryIntents.length > 0) {
      prompt += `Secondary intents: ${queryPlan.secondaryIntents.join(', ')}\n`;
    }

    if (queryPlan.requiresCurrentDateTime) {
      prompt +=
        'Important: Use the current timestamp above whenever you need to determine whether something is overdue, how much time remains, or whether an expiry date has passed.\n';
    }

    if (queryPlan.requiresTelemetry) {
      prompt +=
        'Important: Telemetry may be required for this answer. Use direct matched telemetry for current readings before falling back to documentation.\n';
    }

    if (queryPlan.requiresTelemetryHistory) {
      prompt +=
        'Important: This question may require historical telemetry or historical operational records. Prefer dated history and time-bounded records over generic guidance.\n';
    }

    if (queryPlan.prefersExactDocumentRows) {
      prompt +=
        'Important: Prefer exact schedule rows, reference IDs, certificate rows, or other explicit document records over broad nearby text.\n';
    }

    if (queryPlan.supportsMultiSourceAggregation) {
      prompt +=
        'Important: Aggregate only clearly matching evidence across the preferred source categories. Keep each fact tied to its supporting source and do not blend conflicting values.\n';
    }

    prompt += '\n';

    return prompt;
  }

  private buildPlannerSpecificGuidance(
    queryPlan: ChatQueryPlan,
    context: LLMContext,
  ): string {
    switch (queryPlan.primaryIntent) {
      case 'manual_specification':
        return (
          'Important: The user is asking for a documented specification, limit, interval, or normal operating range. ' +
          'Answer from the matching manual or explicitly requested source first. ' +
          'Do not replace a manual specification answer with current telemetry unless the user explicitly asked for the current reading.\n\n'
        );
      case 'maintenance_procedure':
        return (
          'Important: This is a maintenance procedure question. ' +
          'Answer from explicitly documented procedure steps only. ' +
          'If the citations contain a step-by-step procedure, present it clearly as documented steps plus safety warnings. ' +
          'Do not begin the answer with telemetry or current sensor values unless the user explicitly asked for a current reading.\n\n'
        );
      case 'last_maintenance':
        return (
          'Important: The user is asking about the last completed maintenance event. ' +
          'Prefer explicit completed-history or PMS records with the last completed date, hours, or status. ' +
          'Do not infer the last completed event from a next-due row unless the documentation explicitly ties them together.\n\n'
        );
      case 'certificate_status':
        return (
          'Important: The user is asking about certificate validity or expiry. ' +
          'Answer with the documented expiry or valid-until date first. ' +
          'Use the current timestamp above to state whether the certificate is still valid, expired, or how much time remains. ' +
          'Use regulations only for renewal consequences or compliance implications, not as the primary source of the expiry date.\n\n'
        );
      case 'regulation_compliance':
        return (
          'Important: The user is asking about compliance obligations. ' +
          'Answer from the regulation text first. ' +
          'Use certificates, PMS records, or manuals only to add vessel-specific status, deadlines, or equipment impact when those documents clearly support it.\n\n'
        );
      case 'analytics_forecast':
        return (
          'Important: This is an analytical or forecast question. ' +
          'State the data range used, the figures used in the calculation, and the final result. ' +
          'If there are fewer than two relevant historical periods or data points, say that the history is insufficient for a reliable forecast instead of guessing.\n\n'
        );
      case 'telemetry_history':
        return (
          'Important: The user is asking about a historical vessel state or position. ' +
          'Prefer dated logs, history records, or time-bounded telemetry. ' +
          'If the vessel moved during the requested day and no precise time is given, ask for a specific time instead of inventing one position for the whole day.\n\n'
        );
      case 'troubleshooting':
        return (
          'Important: For troubleshooting answers, separate likely documented causes from the immediate checks to perform next. ' +
          'Use the documented alarm meaning, possible causes, and corrective actions first. ' +
          'If current telemetry is present, mention it only when it directly matches the fault under discussion, and do not prepend unrelated telemetry before the documented troubleshooting steps. ' +
          'If the cited evidence does not document a cause or a quick check, do not invent it.\n\n'
        );
      default:
        return '';
    }
  }

  private buildMaintenanceCalculationPrompt(
    context: LLMContext,
    queryPlan?: ChatQueryPlan,
  ): string {
    const effectiveQueryPlan =
      queryPlan ??
      this.queryPlanner.planQuery(
        context.userQuery,
        context.resolvedSubjectQuery,
      );

    if (effectiveQueryPlan.primaryIntent !== 'next_due_calculation') {
      return '';
    }

    const subjectQuery = context.resolvedSubjectQuery ?? context.userQuery;
    const hourTelemetry = this.extractHourTelemetry(
      context.telemetry,
      subjectQuery,
    );
    const documentedIntervals = this.extractDocumentedIntervals(
      context.citations,
      subjectQuery,
    );
    const explicitNextDueValues = this.extractExplicitNextDueHours(
      context.citations,
      subjectQuery,
    );
    const subjectTerms = this.extractSubjectTerms(subjectQuery);

    if (subjectTerms.length === 0) {
      return (
        'Maintenance Calculation Guidance:\n' +
        '- The question does not identify one exact asset, component, maintenance task, or reference ID.\n' +
        '- Do not use telemetry hour counters or generic maintenance intervals to calculate a next-due value for this broad question.\n' +
        '- Ask which exact asset, component, task, or reference row this next-due question is for, or state that the exact next due is not confirmed by the provided documentation.\n\n'
      );
    }

    const canSafelyDeriveNextDue =
      explicitNextDueValues.length > 0 ||
      this.canSafelyDeriveNextDueFromInterval({
        citations: context.citations,
        subjectTerms,
        hourTelemetry,
        documentedIntervals,
      });

    let prompt = 'Maintenance Calculation Guidance:\n';
    prompt +=
      '- Use telemetry hour counters together with the documented service interval that matches the asked maintenance item.\n';
    prompt +=
      '- If you perform a due-hours calculation, show the arithmetic with exact values before the conclusion.\n';
    prompt +=
      '- Do not use an interval unless the snippet clearly refers to the same component, task, or asset as the question.\n';

    if (subjectTerms.length > 0) {
      prompt += `- Subject terms to match: ${subjectTerms.join(', ')}.\n`;
    }

    if (hourTelemetry.length > 0) {
      prompt += 'Detected telemetry hour counters:\n';
      hourTelemetry.forEach((entry) => {
        prompt += `- ${entry.label}: ${this.formatHours(entry.hours)} hours\n`;
      });
    }

    if (documentedIntervals.length > 0) {
      prompt +=
        'Documented hour-based service intervals found in the provided documentation:\n';
      documentedIntervals.forEach((entry) => {
        const pageInfo = entry.pageNumber ? `, page ${entry.pageNumber}` : '';
        prompt += `- [${entry.sourceIndex}] ${entry.intervalHours} hours from ${entry.sourceTitle}${pageInfo}\n`;
      });
    }

    if (explicitNextDueValues.length > 0) {
      prompt +=
        'Explicit next-due hour values found in the provided documentation:\n';
      explicitNextDueValues.forEach((entry) => {
        const pageInfo = entry.pageNumber ? `, page ${entry.pageNumber}` : '';
        prompt += `- [${entry.sourceIndex}] next due ${this.formatHours(entry.nextDueHours)} hours from ${entry.sourceTitle}${pageInfo}\n`;
      });
      prompt +=
        '- Prefer these explicit next-due values over any derived calculation from the interval.\n';
      prompt +=
        '- If explicit next-due values are listed above, do not round to a new interval boundary. Use one of the documented next-due values exactly.\n';
    }

    if (
      explicitNextDueValues.length === 0 &&
      context.citations?.some((citation) => /\bnext\s*due\b/i.test(citation.snippet))
    ) {
      prompt +=
        '- The provided snippets already contain "Next due" schedule fields. If the exact next-due hour is visible in those snippets, answer from that documented next-due row instead of calculating a new rounded hour threshold from the interval.\n';
    }

    if (subjectTerms.length === 0 && documentedIntervals.length > 1) {
      prompt +=
        '- The current question does not identify a single component or task, and multiple different hour-based intervals appear in the snippets. Do not choose one interval unless the documentation explicitly provides the matching next-due value.\n';
    }

    if (!canSafelyDeriveNextDue && explicitNextDueValues.length === 0) {
      prompt +=
        '- The provided documentation does not establish one exact next-due threshold for the asked subject. Do not derive or round a next-due hour value from a generic interval.\n';
      prompt +=
        '- If no explicit next-due value for the same subject is visible, answer that the exact next maintenance due is not confirmed by the provided documentation for that subject.\n';
    }

    if (hourTelemetry.length > 0 && explicitNextDueValues.length > 0) {
      prompt += 'Remaining-hours candidates using explicit next-due values:\n';
      hourTelemetry.forEach((telemetryEntry) => {
        explicitNextDueValues.forEach((nextDueEntry) => {
          const remainingHours = nextDueEntry.nextDueHours - telemetryEntry.hours;
          prompt += `- With ${telemetryEntry.label} = ${this.formatHours(telemetryEntry.hours)} hours and explicit next due ${this.formatHours(nextDueEntry.nextDueHours)} hours from [${nextDueEntry.sourceIndex}], remaining is ${this.formatHours(remainingHours)} hours.\n`;
        });
      });
    } else if (
      canSafelyDeriveNextDue &&
      hourTelemetry.length > 0 &&
      documentedIntervals.length > 0
    ) {
      prompt += 'Calculated next-due candidates:\n';
      hourTelemetry.forEach((telemetryEntry) => {
        documentedIntervals.forEach((intervalEntry) => {
          const nextDueHours =
            Math.ceil(telemetryEntry.hours / intervalEntry.intervalHours) *
            intervalEntry.intervalHours;
          const remainingHours = nextDueHours - telemetryEntry.hours;
          prompt += `- With ${telemetryEntry.label} = ${this.formatHours(telemetryEntry.hours)} hours and interval ${intervalEntry.intervalHours} hours from [${intervalEntry.sourceIndex}], next due is ${this.formatHours(nextDueHours)} hours, remaining ${this.formatHours(remainingHours)} hours.\n`;
        });
      });
    }

    prompt += '\n';
    return prompt;
  }

  private formatCitationSourceLabel(citation: {
    sourceTitle: string;
    sourceCategory?: string;
  }): string {
    const sourceType = this.getCitationSourceType(citation);
    if (sourceType === 'PMS') {
      return `[PMS] ${citation.sourceTitle}`;
    }

    return `[${sourceType}: ${citation.sourceTitle}]`;
  }

  private getCitationSourceType(citation: {
    sourceTitle: string;
    sourceCategory?: string;
  }): 'Manual' | 'History' | 'Certificate' | 'Regulation' | 'PMS' {
    const sourceTitle = citation.sourceTitle.toLowerCase();
    if (
      /maintenance\s+tasks|planned\s+maintenance|pms|maintenance\s+schedule/.test(
        sourceTitle,
      )
    ) {
      return 'PMS';
    }

    switch (citation.sourceCategory) {
      case 'HISTORY_PROCEDURES':
        return 'History';
      case 'CERTIFICATES':
        return 'Certificate';
      case 'REGULATION':
        return 'Regulation';
      default:
        return 'Manual';
    }
  }

  private isMaintenanceCalculationQuery(query: string): boolean {
    return /(when\s+is\s+.*(maintenance|service)\s+due|when\s+should\s+we\s+do\s+next\s+(maintenance|service)|what\s+is\s+next\s+due|next\s+due\s+value|next\s+(maintenance|service)\s+due|how\s+many\s+hours\s+(left|remaining)|remaining\s+hours|hours\s+until\s+next\s+(maintenance|service)|next\s+service\s+at\s+what\s+hour)/i.test(
      query,
    );
  }

  /**
   * Returns true for short, non-question inputs that look like a code, label,
   * title, or path fragment. Uses only generic structural heuristics.
   */
  private isFragmentReferenceQuery(query: string): boolean {
    const trimmed = query.trim();
    // Must be short enough to be a label rather than a sentence
    if (trimmed.length > 60) return false;
    // Questions are never fragments
    if (trimmed.includes('?')) return false;
    // Inputs containing question or request words are not fragments
    if (
      /\b(what|when|where|why|how|who|is|are|does|can|will|should|tell|explain|list|show|give|find)\b/i.test(
        trimmed,
      )
    )
      return false;
    // Maintenance task titles like "JET SKI ANNUAL SERVICE" should be treated
    // as concrete subjects, not as opaque fragment codes.
    if (
      /\b(service|maintenance|task|annual|biennial|monthly|weekly|daily|hrs?|hours?|overhaul|inspection|inspect|replace|clean|check)\b/i.test(
        trimmed,
      )
    ) {
      return false;
    }
    if (/\b(?:reference\s*id\s*)?1p\d{2,}\b/i.test(trimmed)) {
      return false;
    }
    // Path-like input (contains slash or backslash)
    if (/[\\/]/.test(trimmed)) return true;
    // Contains a 3-or-more-digit code number
    if (/\b\d{3,}\b/.test(trimmed)) return true;
    // Mostly uppercase identifier (e.g. "FUEL SYSTEM" or "MAIN ENGINE")
    if (/^[A-Z][A-Z0-9 _-]{3,}$/.test(trimmed)) return true;
    // Very short input with no question structure (4 words or fewer)
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    return wordCount <= 4;
  }

  private classifyQueryIntent(query: string): QueryIntent {
    const plannedIntent = this.queryPlanner.classifyPrimaryIntent(query);

    if (
      plannedIntent === 'telemetry_list' ||
      plannedIntent === 'telemetry_status' ||
      plannedIntent === 'manual_specification' ||
      plannedIntent === 'maintenance_due_now' ||
      plannedIntent === 'next_due_calculation' ||
      plannedIntent === 'parts_fluids_consumables' ||
      plannedIntent === 'maintenance_procedure' ||
      plannedIntent === 'troubleshooting'
    ) {
      return plannedIntent;
    }

    if (plannedIntent === 'fragment_reference' || this.isFragmentReferenceQuery(query)) {
      return 'fragment_reference';
    }

    return 'general';
  }

  private isDirectLookupSubjectQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed || trimmed.includes('?')) return false;
    if (this.isFragmentReferenceQuery(trimmed)) return false;
    if (/\b(?:reference\s*id\s*)?1p\d{2,}\b/i.test(trimmed)) return true;

    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 10) return false;

    return /\b(service|maintenance|task|annual|biennial|monthly|weekly|daily|hrs?|hours?|overhaul|inspection|engine|generator|pump|filter|filters|jet\s*ski|castoldi|reference\s*id)\b/i.test(
      trimmed,
    );
  }

  private hasExplicitSourceRequest(query: string): boolean {
    return /\b(?:according\s+to|from|in)\s+the\s+.+?\b(manual|operator'?s\s+manual|operators\s+manual|handbook|guide|document)\b/i.test(
      query,
    );
  }

  private hasExactReferenceId(
    userQuery: string,
    resolvedSubjectQuery?: string,
  ): boolean {
    return /\b1p\d{2,}\b/i.test(`${userQuery}\n${resolvedSubjectQuery ?? ''}`);
  }

  private wantsExhaustiveTableAnswer(query: string): boolean {
    return /\b(list\s+all|all\s+details|do\s+not\s+omit|how\s+many\s+spare-?part\s+rows)\b/i.test(
      query,
    );
  }

  private hasExplicitPartsEvidence(citations?: LLMContext['citations']): boolean {
    if (!citations?.length) return false;

    return citations.some((citation) =>
      /\b(spare\s*name|manufacturer\s*part#?|supplier\s*part#?|quantity|location)\b/i.test(
        citation.snippet,
      ),
    );
  }

  private extractHourTelemetry(
    telemetry?: Record<string, unknown>,
    subjectQuery?: string,
  ): HourTelemetryEntry[] {
    if (!telemetry) return [];

    const result: HourTelemetryEntry[] = [];
    for (const [label, value] of Object.entries(telemetry)) {
      if (!/(engine|runtime|running|operating|hour|hourmeter)/i.test(label)) {
        continue;
      }
      const numericValue = this.parseNumericValue(value);
      if (numericValue == null) continue;
      result.push({ label, hours: numericValue });
    }

    const subjectTerms = this.extractSubjectTerms(subjectQuery ?? '');
    if (subjectTerms.length === 0) return result;

    const matched = result.filter((entry) => {
      const haystack = entry.label.toLowerCase();
      return subjectTerms.some((term) => haystack.includes(term));
    });

    return matched.length > 0 ? matched : result;
  }

  private isTelemetryValueQuery(query: string): boolean {
    if (this.isLocationTelemetryQuery(query)) {
      return true;
    }

    if (
      /(telemetry|running\s+hours|hour\s*meter|hours\s*run|runtime)\b/i.test(
        query,
      )
    ) {
      return true;
    }

    if (/[a-z0-9]+(?:[_-][a-z0-9]+)+/i.test(query)) {
      return true;
    }

    const asksForCurrentReading =
      /\b(current|currently|status|reading|value|temperature|temp|pressure|level|voltage|amperage|current draw|load|rpm|speed|flow|rate)\b/i.test(
        query,
      );
    const mentionsTelemetrySignal =
      /\b(oil|fuel|coolant|fresh\s*water|seawater|water|tank|battery|depth|rudder|trim|temperature|temp|pressure|voltage|current|load|rpm|speed|level|flow|rate|generator|engine|pump|compressor|sensor|meter)\b/i.test(
        query,
      );

    return asksForCurrentReading && mentionsTelemetrySignal;
  }

  private isTelemetryAggregateCalculationQuery(query: string): boolean {
    return (
      /\b(how\s+much|how\s+many|total|sum|overall|combined|together|calculate)\b/i.test(
        query,
      ) &&
      /\b(fuel|oil|coolant|water|tank|tanks)\b/i.test(query)
    );
  }

  private isLocationTelemetryQuery(query: string): boolean {
    return (
      /\b(latitude|longitude|lat|lon|coordinates?|position|gps|location)\b/i.test(
        query,
      ) &&
      !/\b(spare|part|parts|supplier|manufacturer|quantity|reference)\b/i.test(
        query,
      )
    );
  }

  private isTelemetryListQuery(query: string): boolean {
    return (
      /\b(show|list|display|give|return|output)\b/i.test(query) &&
      /\b(metrics?|telemetry|readings?|values?)\b/i.test(query) &&
      /\b(active|connected|enabled|current|random|\d{1,2})\b/i.test(query)
    );
  }

  private isTelemetryGuidedDocumentationQuery(query: string): boolean {
    const asksForCurrentState =
      /\b(current|currently|status|reading|value|level|temperature|temp|pressure|voltage|load|rpm|speed|flow|rate)\b/i.test(
        query,
      ) && /\b(oil|fuel|coolant|water|tank|battery|depth|temperature|pressure|voltage|load|rpm|speed|flow|rate|generator|engine|pump|compressor|sensor|meter)\b/i.test(
        query,
      );
    const asksForGuidance =
      /\b(based\s+on|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+should\s+be\s+done|what\s+needs?\s+to\s+be\s+done|recommended|recommendation|action|next\s+step|do\s+next)\b/i.test(
        query,
      );

    return asksForCurrentState && asksForGuidance;
  }

  private extractDocumentedIntervals(
    citations?: LLMContext['citations'],
    subjectQuery?: string,
  ): DocumentedIntervalEntry[] {
    if (!citations?.length) return [];

    const seen = new Set<string>();
    const result: DocumentedIntervalEntry[] = [];
    const subjectTerms = this.extractSubjectTerms(subjectQuery ?? '');

    citations.forEach((citation, idx) => {
      const haystack = `${citation.sourceTitle}\n${citation.snippet}`.toLowerCase();
      if (
        subjectTerms.length > 0 &&
        !subjectTerms.some((term) => haystack.includes(term))
      ) {
        return;
      }

      const matches = citation.snippet.matchAll(
        /(?:every|each|after|at|due(?:\s+every)?|replace(?:\s+.*?\s+every)?|change(?:\s+.*?\s+every)?)?\s*(\d+(?:[\s,]\d{3})*(?:\.\d+)?)\s*(?:hours?|hrs?|hr|h)\b/gi,
      );

      for (const match of matches) {
        const numeric = Number(match[1].replace(/[\s,]/g, ''));
        if (!Number.isFinite(numeric) || numeric <= 0) continue;

        const dedupeKey = `${idx + 1}:${numeric}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        result.push({
          intervalHours: numeric,
          sourceIndex: idx + 1,
          sourceTitle: citation.sourceTitle,
          pageNumber: citation.pageNumber,
        });
      }
    });

    return result;
  }

  private extractExplicitNextDueHours(
    citations?: LLMContext['citations'],
    subjectQuery?: string,
  ): ExplicitNextDueEntry[] {
    if (!citations?.length) return [];

    const seen = new Set<string>();
    const result: ExplicitNextDueEntry[] = [];
    const subjectTerms = this.extractSubjectTerms(subjectQuery ?? '');

    citations.forEach((citation, idx) => {
      const haystack = `${citation.sourceTitle}\n${citation.snippet}`.toLowerCase();
      if (
        subjectTerms.length > 0 &&
        !subjectTerms.some((term) => haystack.includes(term))
      ) {
        return;
      }

      const slashMatches = citation.snippet.matchAll(
        /next\s*due[\s\S]{0,400}?\/\s*(\d{3,6})\b/gi,
      );

      for (const match of slashMatches) {
        const numeric = Number(match[1]);
        if (!Number.isFinite(numeric) || numeric <= 0) continue;

        const dedupeKey = `${idx + 1}:${numeric}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        result.push({
          nextDueHours: numeric,
          sourceIndex: idx + 1,
          sourceTitle: citation.sourceTitle,
          pageNumber: citation.pageNumber,
        });
      }

      if (
        /\bnext\s*due\b/i.test(citation.snippet) &&
        !result.some((entry) => entry.sourceIndex === idx + 1)
      ) {
        const allSlashHours = [
          ...citation.snippet.matchAll(/\/\s*(\d{3,6})\b/g),
        ].map((match) => Number(match[1]));
        const fallbackNumeric = allSlashHours[allSlashHours.length - 1];
        if (Number.isFinite(fallbackNumeric) && fallbackNumeric > 0) {
          const dedupeKey = `${idx + 1}:${fallbackNumeric}`;
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            result.push({
              nextDueHours: fallbackNumeric,
              sourceIndex: idx + 1,
              sourceTitle: citation.sourceTitle,
              pageNumber: citation.pageNumber,
            });
          }
        }
      }
    });

    return result;
  }

  private extractSubjectTerms(query: string): string[] {
    const stopWords = new Set([
      'what',
      'when',
      'where',
      'why',
      'how',
      'about',
      'next',
      'maintenance',
      'service',
      'due',
      'hours',
      'hour',
      'remaining',
      'left',
      'provide',
      'please',
      'show',
      'list',
      'all',
      'task',
      'tasks',
      'parts',
      'part',
      'procedure',
      'steps',
      'this',
      'that',
      'these',
      'those',
      'sure',
      'correct',
      'should',
      'use',
      'need',
      'needs',
      'done',
      'doing',
      'with',
      'from',
      'into',
      'the',
      'a',
      'an',
      'i',
      'we',
      'do',
      'does',
      'did',
      'is',
      'are',
      'can',
      'could',
      'would',
      'should',
      'my',
      'our',
      'your',
      'you',
    ]);

    const terms = query
      .toLowerCase()
      .replace(/[^a-z0-9\s/-]/g, ' ')
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean)
      .filter((term) => term.length >= 2)
      .filter((term) => !stopWords.has(term))
      .filter((term) => !/^\d+$/.test(term));

    return [
      ...new Set(
        terms.filter((term) => term.length >= 3 || term === 'ps' || term === 'sb'),
      ),
    ];
  }

  private parseNumericValue(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const match = value.match(/-?\d+(?:[\s,]\d{3})*(?:\.\d+)?/);
    if (!match) return null;

    const normalized = match[0].replace(/[\s,]/g, '');
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private formatHours(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }

  private canSafelyDeriveNextDueFromInterval(params: {
    citations?: LLMContext['citations'];
    subjectTerms: string[];
    hourTelemetry: HourTelemetryEntry[];
    documentedIntervals: DocumentedIntervalEntry[];
  }): boolean {
    const { citations, subjectTerms, hourTelemetry, documentedIntervals } = params;

    if (subjectTerms.length === 0) return false;
    if (hourTelemetry.length !== 1) return false;
    if (documentedIntervals.length !== 1) return false;

    const matchedSubjectCitations =
      citations?.filter((citation) => {
        const haystack =
          `${citation.sourceTitle ?? ''}\n${citation.snippet ?? ''}`.toLowerCase();
        return subjectTerms.some((term) => haystack.includes(term));
      }) ?? [];

    if (matchedSubjectCitations.length === 0) return false;

    const matchingScheduleEvidence = matchedSubjectCitations.filter((citation) =>
      /\b(interval|last\s*due|next\s*due|reference\s*id|task\s*name|component\s*name|maintenance\s+tasks?)\b/i.test(
        citation.snippet ?? '',
      ),
    );

    return matchingScheduleEvidence.length === 1;
  }
}
