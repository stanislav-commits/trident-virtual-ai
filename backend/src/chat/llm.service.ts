import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';

export interface LLMContext {
  userQuery: string;
  previousUserQuery?: string;
  resolvedSubjectQuery?: string;
  citations?: Array<{
    snippet: string;
    sourceTitle: string;
    pageNumber?: number;
  }>;
  shipName?: string;
  telemetry?: Record<string, unknown>;
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
  | 'telemetry_status'
  | 'maintenance_due_now'
  | 'next_due_calculation'
  | 'parts_fluids_consumables'
  | 'maintenance_procedure'
  | 'troubleshooting'
  | 'fragment_reference'
  | 'general';

@Injectable()
export class LlmService {
  private client: OpenAI;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor() {
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
      const systemPrompt = this.buildSystemPrompt(context.shipName);
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

  private buildSystemPrompt(shipName?: string): string {
    const name = shipName ? ` (${shipName})` : '';
    return `You are a technical support assistant for yacht operations and maintenance${name}.
Your role is to provide accurate, actionable answers based only on the provided manuals, maintenance schedules, parts lists, procedures, and telemetry.

Core rules:
- Answer the user's exact question directly in the first sentence, then add concise supporting details.
- Base your answer primarily on explicit evidence from the provided documentation. Prefer direct document evidence over inference.
- Use telemetry only when it is relevant to the user's exact question.
- Do not speculate or rely on general marine/mechanical knowledge when the documents do not provide the answer.
- When referencing provided documentation, use inline citation markers like [1], [2], etc. matching the numbered sources in "Relevant Documentation". Place citations naturally at the end of the sentence or fact they support.
- Include safety warnings when relevant.
- Keep responses concise, practical, and focused.
- Use technical terminology appropriately, but explain complex points briefly.
- Do not use LaTeX, TeX delimiters, or escaped math syntax like \\( \\), \\[ \\], \\frac, or \\text in the final answer.

Intent handling:
- Treat each new user question as a fresh retrieval task unless the user explicitly refers to a previous answer.
- Do not reuse a previous maintenance-hours calculation for a new question unless the user explicitly asks to continue or reuse it.
- First determine the user's intent before answering. Typical intents include:
  - telemetry or current status
  - maintenance due now
  - next maintenance due calculation
  - spare parts / consumables / fluids
  - maintenance procedure
  - troubleshooting / fault finding
- Clearly distinguish intent:
  - "what maintenance is due?" / "what service is due now?" => identify named due or next-due task(s) from maintenance records
  - "when is the next maintenance due?" => provide due threshold/time and calculate only if needed
- Do not switch to maintenance interval calculations unless the user explicitly asks for a due-time calculation, such as:
  "when is the next maintenance due",
  "how many hours left",
  "remaining hours",
  "next service at what hour"
- If the user asks "what maintenance is due?" or "what service is due now?", look for explicitly named due tasks, next-due tasks, or last-due records in the provided documentation. Report only those named items. Do not answer with a calculated hour threshold. Do not list or enumerate task names that are not present in the provided documentation.
- If no maintenance task information is present in the provided documentation for a due-task query, clearly state that the documentation does not identify any due tasks for the asset. Do not guess or use general knowledge to fill in task names.
- Do not convert a due-task question into a due-hours calculation unless no identifiable task information is available in the provided documentation.
- If the user asks about spare parts, consumables, filters, oil, coolant, or fluid quantities, answer only from explicit parts lists, service procedures, specifications, or capacities found in the provided documentation.
- If the user asks about a procedure, provide the documented steps or summarize the documented procedure. Do not replace a procedure answer with a due-hours calculation.
- If the user message is only a short opaque label, code, or fragment, ask a short clarifying question instead of inferring a full maintenance answer.
- If the user message is a concrete task title, service title, component name, or maintenance item, treat it as a lookup request for that named item instead of asking the user to restate the same subject.
- If the user asks for a named task, service, component, or reference ID, do not substitute a nearby but different task just because it has a similar interval or wording. If the exact asked item is not clearly present in the provided snippets, say so.
- If the current question is a short follow-up and prior user context is provided, treat it as continuing the previous subject. Do not ask the user to repeat the same subject unless the previous subject is still genuinely ambiguous.
- If the retrieved snippets mix multiple unrelated components, tasks, or manuals, do not merge them into one answer. Use only the snippets that clearly match the asked subject. If no single subject match is clear, say the retrieved context is ambiguous and ask a short clarification.
- If multiple manuals are relevant, clearly separate maintenance-schedule facts from operator-manual guidance. Say which source identifies the due task or task list, and which source only gives general procedure or safety information.
- If the user explicitly asks "according to" a named manual, handbook, guide, or document, answer from that named source when matching citations from it are present. Do not switch to a different document just because it has more detailed but unrelated content.
- If the user asks about one exact reference ID, use only the snippets tied to that exact reference ID plus obvious continuation lines from the same row/page. Do not borrow tasks, parts, or part numbers from nearby reference rows.
- If the user asks for "all details", "list all", "do not omit any row", or asks how many spare-part rows exist, treat the relevant parts table as exhaustive. Merge wrapped lines that clearly belong to the same row, and do not stop early when more rows remain in the provided context.

Maintenance and calculation rules:
- Never assume a maintenance interval unless that exact interval is stated in the provided documentation for the same component or task.
- Only perform a next-due or remaining-hours calculation when both conditions are true:
  1) the user explicitly asked for a calculation, and
  2) the exact interval is stated in the provided documentation for the same task or component.
- If a maintenance table already contains fields such as "Due", "Next due", "Last due", "Status", or equivalent, use those values directly instead of recalculating.
- If both "Last due" and "Next due" are present, answer from the "Next due" field when the user asks what is next due. Never report the "Last due" value as the next due value.
- If multiple documented intervals exist, use the one that matches the specific task or component asked about.
- If the matching task or component is ambiguous, briefly state the ambiguity and ask a short clarifying question or explain which task you matched.

Calculation format:
- Only show calculations when they are necessary to answer the user's question.
- Keep calculations short and in plain text.
- When calculation is needed, use:
  next_due_hours = ceil(current_hours / interval_hours) * interval_hours
  remaining_hours = next_due_hours - current_hours
- When an explicit next-due value is already present in the documentation, prefer that value over a calculation.
- If multiple different hour-based intervals appear in the provided snippets and they are not clearly tied to the same asked component or task, do not choose one. State that the available documentation context is ambiguous.

Parts / fluids / consumables rules:
- For spare parts, consumables, and fluid quantities, provide exact part names, part numbers, filter references, oil grades, and capacities only when they are explicitly present in the provided documentation.
- Do not infer "typical" parts or quantities from general knowledge.
- Do not present maintenance actions such as "replace oil filter" or "inspect belts" as spare parts unless the documentation explicitly names a spare item, consumable, quantity, or part number.
- If the provided documents do not include exact spare parts or fluid quantities, clearly state that the information is not available in the provided documentation.
- If the user asks for parts for a named maintenance task or component and the retrieved snippets show the task but not a parts list for that same task or component, state that the parts are not shown in the provided documentation for that item.

Telemetry rules:
- Use telemetry to report current readings or support a calculation only when relevant.
- Do not let telemetry override explicit maintenance records, schedules, procedures, or parts information found in the documentation.

Answer style:
- If the answer is directly available in the documents, state it clearly and cite it.
- If the answer is partially available, say what is confirmed and what is missing.
- If the documents do not contain the answer, state that clearly and do not speculate.
- Do not answer a parts, fluid, or procedure question with a maintenance-due calculation unless the user explicitly asked for that calculation.`;
  }

  private buildUserPrompt(context: LLMContext): string {
    const intent = this.classifyQueryIntent(context.userQuery);
    let prompt = `Detected intent: ${intent}\nQuestion: ${context.userQuery}\n\n`;

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

    if (this.hasExactReferenceId(context.userQuery, context.resolvedSubjectQuery)) {
      prompt +=
        'Important: The user is asking about an exact reference ID. ' +
        'Use only the matching reference row plus obvious continuation lines tied to that same row or same page. ' +
        'Do not borrow tasks, spare parts, or part numbers from earlier or later unrelated reference rows in the same snippet.\n\n';
    }

    if (intent === 'maintenance_procedure' && context.resolvedSubjectQuery) {
      prompt +=
        'Important: The user is asking what to do for the maintenance item already identified in prior context. ' +
        'Prefer the task list or included work items from the matching maintenance schedule row for that subject. ' +
        'If the schedule row lists the task items explicitly, list those scheduled tasks first. ' +
        'Use generic manual procedure text only as supplementary guidance, and label it as general guidance rather than the task list itself.\n\n';
    }

    if (
      intent === 'parts_fluids_consumables' &&
      context.resolvedSubjectQuery
    ) {
      prompt +=
        'Important: The user is asking for spare parts or consumables for the maintenance item already identified in prior context. ' +
        'Prefer an explicit spare-parts table or part-number block tied to that same maintenance row or component. ' +
        'If such a list is present, return all documented spare names, quantities, locations, and part numbers from that matching list instead of saying the parts are unavailable.\n\n';
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
        prompt += `[${idx + 1}] ${citation.sourceTitle}${pageInfo}:\n`;
        prompt += `${citation.snippet}\n\n`;
      });
    } else if (context.noDocumentation) {
      prompt +=
        'Note: No matching documentation context was found for this query. ' +
        'If this query relates to maintenance tasks or due service items, do NOT list or invent maintenance items — they are not confirmed by the provided documentation. ' +
        'Use telemetry only if it directly answers the question. ' +
        'If the answer is not supported by the provided context, clearly state that the documentation does not confirm it. ' +
        'Do not speculate. Do not use citation markers like [1], [2].\n\n';
    }

    if (context.telemetry && Object.keys(context.telemetry).length > 0) {
      prompt += 'Current Telemetry:\n';
      Object.entries(context.telemetry).forEach(([key, value]) => {
        prompt += `- ${key}: ${value}\n`;
      });
      prompt += '\n';
    }

    const maintenanceGuidance = this.buildMaintenanceCalculationPrompt(context);
    if (maintenanceGuidance) {
      prompt += maintenanceGuidance;
    }

    return prompt;
  }

  private buildMaintenanceCalculationPrompt(context: LLMContext): string {
    if (
      this.classifyQueryIntent(context.userQuery) !== 'next_due_calculation'
    ) {
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
        '- If explicit next-due values are listed above, do not round to the next interval boundary such as 2500. Use one of the documented next-due values exactly.\n';
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

    if (hourTelemetry.length > 0 && explicitNextDueValues.length > 0) {
      prompt += 'Remaining-hours candidates using explicit next-due values:\n';
      hourTelemetry.forEach((telemetryEntry) => {
        explicitNextDueValues.forEach((nextDueEntry) => {
          const remainingHours = nextDueEntry.nextDueHours - telemetryEntry.hours;
          prompt += `- With ${telemetryEntry.label} = ${this.formatHours(telemetryEntry.hours)} hours and explicit next due ${this.formatHours(nextDueEntry.nextDueHours)} hours from [${nextDueEntry.sourceIndex}], remaining is ${this.formatHours(remainingHours)} hours.\n`;
        });
      });
    } else if (hourTelemetry.length > 0 && documentedIntervals.length > 0) {
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

  private isMaintenanceCalculationQuery(query: string): boolean {
    return /(when\s+is\s+.*(maintenance|service)\s+due|what\s+is\s+next\s+due|next\s+due\s+value|next\s+(maintenance|service)\s+due|how\s+many\s+hours\s+(left|remaining)|remaining\s+hours|hours\s+until\s+next\s+(maintenance|service)|next\s+service\s+at\s+what\s+hour)/i.test(
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
    const q = query.toLowerCase();

    if (this.isMaintenanceCalculationQuery(q)) {
      return 'next_due_calculation';
    }

    if (
      /\b(parts?|spare\s*parts?|spares?|consumables?|fluids?|oil|coolant|filter|filters|quantity|quantities|capacity|capacities|part\s*numbers?)\b/i.test(
        q,
      )
    ) {
      return 'parts_fluids_consumables';
    }

    if (
      /(procedure|steps?|how\s+to|instruction|instructions|checklist|perform|replace|clean|inspect|what\s+should\s+i\s+do|what\s+do\s+i\s+do|what\s+needs?\s+to\s+be\s+done|what\s+should\s+be\s+done)/i.test(
        q,
      )
    ) {
      return 'maintenance_procedure';
    }

    if (
      /(fault|alarm|error|troubleshoot|issue|problem|not\s+working|failure)/i.test(
        q,
      )
    ) {
      return 'troubleshooting';
    }

    if (
      /(what\s+maintenance\s+is\s+due|what\s+service\s+is\s+due|due\s+now|maintenance\s+due\s+now|service\s+due\s+now|what\s+is\s+the\s+next\s+(maintenance|service)|what\s+(maintenance|service)\s+is\s+next)/i.test(
        q,
      )
    ) {
      return 'maintenance_due_now';
    }

    if (
      /(telemetry|status|current|running\s+hours|hour\s*meter|hours\s*run|runtime)/i.test(
        q,
      )
    ) {
      return 'telemetry_status';
    }

    // Detect short fragment/code/title inputs after explicit task intents.
    if (this.isFragmentReferenceQuery(query)) {
      return 'fragment_reference';
    }

    return 'general';
  }

  private isDirectLookupSubjectQuery(query: string): boolean {
    const trimmed = query.trim();
    if (!trimmed || trimmed.includes('?')) return false;
    if (this.isFragmentReferenceQuery(trimmed)) return false;

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
}
