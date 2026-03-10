import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';

export interface LLMContext {
  userQuery: string;
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
        const historyMessages = context.chatHistory.map((msg) => ({
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content,
        }));
        messages.push(...historyMessages);
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
- If the user message is only a short label, code, title, or fragment, ask a short clarifying question instead of inferring a full maintenance answer.

Maintenance and calculation rules:
- Never assume a maintenance interval unless that exact interval is stated in the provided documentation for the same component or task.
- Only perform a next-due or remaining-hours calculation when both conditions are true:
  1) the user explicitly asked for a calculation, and
  2) the exact interval is stated in the provided documentation for the same task or component.
- If a maintenance table already contains fields such as "Due", "Next due", "Last due", "Status", or equivalent, use those values directly instead of recalculating.
- If multiple documented intervals exist, use the one that matches the specific task or component asked about.
- If the matching task or component is ambiguous, briefly state the ambiguity and ask a short clarifying question or explain which task you matched.

Calculation format:
- Only show calculations when they are necessary to answer the user's question.
- Keep calculations short and in plain text.
- When calculation is needed, use:
  next_due_hours = ceil(current_hours / interval_hours) * interval_hours
  remaining_hours = next_due_hours - current_hours
- When an explicit next-due value is already present in the documentation, prefer that value over a calculation.

Parts / fluids / consumables rules:
- For spare parts, consumables, and fluid quantities, provide exact part names, part numbers, filter references, oil grades, and capacities only when they are explicitly present in the provided documentation.
- Do not infer "typical" parts or quantities from general knowledge.
- If the provided documents do not include exact spare parts or fluid quantities, clearly state that the information is not available in the provided documentation.

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

    const hourTelemetry = this.extractHourTelemetry(context.telemetry);
    const documentedIntervals = this.extractDocumentedIntervals(
      context.citations,
    );

    let prompt = 'Maintenance Calculation Guidance:\n';
    prompt +=
      '- Use telemetry hour counters together with the documented service interval that matches the asked maintenance item.\n';
    prompt +=
      '- If you perform a due-hours calculation, show the arithmetic with exact values before the conclusion.\n';

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

    if (hourTelemetry.length > 0 && documentedIntervals.length > 0) {
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
    return /(when\s+is\s+.*(maintenance|service)\s+due|next\s+(maintenance|service)\s+due|how\s+many\s+hours\s+(left|remaining)|remaining\s+hours|hours\s+until\s+next\s+(maintenance|service)|next\s+service\s+at\s+what\s+hour)/i.test(
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

    // Detect short fragment/code/title inputs before any other classification
    if (this.isFragmentReferenceQuery(query)) {
      return 'fragment_reference';
    }

    if (this.isMaintenanceCalculationQuery(q)) {
      return 'next_due_calculation';
    }

    if (
      /(spare\s*parts?|consumables?|fluids?|oil|coolant|filter|filters|quantity|quantities|capacity|capacities)/i.test(
        q,
      )
    ) {
      return 'parts_fluids_consumables';
    }

    if (
      /(procedure|steps?|how\s+to|instruction|instructions|checklist|perform|replace|clean|inspect)/i.test(
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
      /(what\s+maintenance\s+is\s+due|what\s+service\s+is\s+due|due\s+now|maintenance\s+due\s+now|service\s+due\s+now)/i.test(
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

    return 'general';
  }

  private extractHourTelemetry(
    telemetry?: Record<string, unknown>,
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
    return result;
  }

  private extractDocumentedIntervals(
    citations?: LLMContext['citations'],
  ): DocumentedIntervalEntry[] {
    if (!citations?.length) return [];

    const seen = new Set<string>();
    const result: DocumentedIntervalEntry[] = [];

    citations.forEach((citation, idx) => {
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
