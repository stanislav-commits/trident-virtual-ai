import { formatError } from '../../common/utils/error.utils';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IntegrationStatusDto } from '../../common/dto/integration-status.dto';
import {
  WebSearchContextReference,
  WebSearchQueryInput,
  WebSearchResult,
} from './web-search.types';

interface ResponsesApiOutputTextAnnotation {
  type?: string;
  title?: string;
  url?: string;
}

interface ResponsesApiMessageContentItem {
  type?: string;
  text?: string;
  annotations?: ResponsesApiOutputTextAnnotation[];
}

interface ResponsesApiOutputItem {
  type?: string;
  content?: ResponsesApiMessageContentItem[];
  action?: {
    sources?: Array<{
      type?: string;
      url?: string;
    }>;
  };
}

interface ResponsesApiPayload {
  error?: {
    message?: string;
  } | null;
  output?: ResponsesApiOutputItem[];
}

/**
 * Caps for the web_search tool (both providers). Keeping these tight beats
 * letting the model wander: latency stays bounded, the model is forced to
 * settle for the best of a few hits instead of stretching to 100+ random
 * sources, and the source panel users see is scannable.
 */
const MAX_WEB_SEARCH_TOOL_CALLS = 3;
const MAX_RETURNED_REFERENCES = 5;

// ── Anthropic Messages API shapes (web search branch) ──────────────────────

interface AnthropicWebCitation {
  type?: string;
  url?: string;
  title?: string;
}

interface AnthropicWebContentBlock {
  type?: string;
  text?: string;
  citations?: AnthropicWebCitation[];
  content?: Array<{ type?: string; url?: string; title?: string }>;
}

interface AnthropicWebResponse {
  content?: AnthropicWebContentBlock[];
  stop_reason?: string;
  error?: { message?: string } | null;
}

@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);

  constructor(private readonly configService: ConfigService) {}

  getStatus(): IntegrationStatusDto {
    const hasApiKey = Boolean(this.getApiKey());
    const anthropicActive = this.shouldUseAnthropic();
    return {
      name: 'web-search',
      configured: hasApiKey || anthropicActive,
      reachable: false,
      details: anthropicActive
        ? `Anthropic native web search active (main model "${this.configService.get<string>('integrations.llm.model', '')}"); OpenAI Responses ("${this.getModel()}") as fallback.`
        : hasApiKey
          ? `OpenAI Responses web search is configured with model "${this.getModel()}".`
          : 'WEB_SEARCH_API_KEY or LLM_API_KEY must be configured for OpenAI web search.',
    };
  }

  async search(input: WebSearchQueryInput): Promise<WebSearchResult> {
    // When the main chat model is Claude, run web search natively through
    // Anthropic's server-side web_search tool: the SAME model that talks to
    // the user formulates the queries, reads the results, and writes the
    // answer in its own voice with inline citations — instead of a detached
    // gpt-5-mini summary glued in afterwards. Falls back to the OpenAI
    // Responses path on any Anthropic failure so web answers never go dark.
    if (this.shouldUseAnthropic()) {
      try {
        return await this.searchViaAnthropic(input);
      } catch (error) {
        this.logger.warn(
          `Anthropic web search failed, falling back to OpenAI: ${
            formatError(error)
          }`,
        );
      }
    }

    if (!this.getApiKey()) {
      throw new ServiceUnavailableException(
        'OpenAI web search is not configured yet.',
      );
    }

    const payload = await this.createResponse(input);
    const answer = this.extractAnswer(payload);
    // Annotation refs = URLs the model cited INLINE (signal). Search-call
    // refs = every URL the search tool happened to visit (mostly noise — the
    // 100+ "View all references" dropdown the user complained about). Prefer
    // citations, top up with at most a couple of search refs if we have
    // fewer than 3, hard cap to keep the panel scannable.
    const contextReferences = this.capContextReferences(
      this.extractContextReferences(payload),
      MAX_RETURNED_REFERENCES,
    );

    return {
      answer:
        answer ??
        'OpenAI web search is configured, but no answer was returned for this request.',
      references: contextReferences.map((reference) => ({
        source: 'web',
        title: reference.sourceTitle ?? 'Web source',
        uri: reference.sourceUrl,
        snippet: reference.snippet,
      })),
      contextReferences,
      provider: 'openai-responses-web-search',
      model: this.getModel(),
    };
  }

  // ── Anthropic branch ──────────────────────────────────────────────────

  private shouldUseAnthropic(): boolean {
    const mainModel = this.configService
      .get<string>('integrations.llm.model', '')
      .trim();
    return /^claude-/i.test(mainModel) && Boolean(this.getAnthropicApiKey());
  }

  private async searchViaAnthropic(
    input: WebSearchQueryInput,
  ): Promise<WebSearchResult> {
    const model = this.configService
      .get<string>('integrations.llm.model', '')
      .trim();
    const baseUrl =
      this.configService
        .get<string>('integrations.llm.anthropicBaseUrl', '')
        .trim() || 'https://api.anthropic.com/v1';

    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: this.buildInputPrompt(input) },
    ];

    // Server-side tools run a sampling loop on Anthropic's side; if it
    // pauses (stop_reason=pause_turn) we append the assistant content and
    // re-send — the server resumes automatically. Bounded to avoid loops.
    let payload: AnthropicWebResponse | null = null;
    for (let continuation = 0; continuation < 4; continuation++) {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.getAnthropicApiKey(),
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          tools: [
            {
              type: 'web_search_20260209',
              name: 'web_search',
              max_uses: MAX_WEB_SEARCH_TOOL_CALLS,
            },
          ],
          messages,
        }),
      });

      const parsed = (await response.json()) as AnthropicWebResponse;
      if (!response.ok) {
        throw new Error(
          parsed?.error?.message ||
            `Anthropic web search failed: ${response.status}`,
        );
      }
      payload = parsed;
      if (parsed.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: parsed.content });
    }

    if (!payload) {
      throw new Error('Anthropic web search returned no payload');
    }

    const blocks = Array.isArray(payload.content) ? payload.content : [];
    const answer = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => (b.text as string).trim())
      .filter(Boolean)
      .join('\n')
      .trim();

    // Inline citations (on text blocks) outrank visited-result URLs from
    // web_search_tool_result blocks — same priority rule as the OpenAI path.
    const refs: WebSearchContextReference[] = [];
    let citationIdx = 0;
    let sourceIdx = 0;
    for (const b of blocks) {
      for (const c of b.citations ?? []) {
        if (typeof c.url !== 'string' || !c.url.trim()) continue;
        citationIdx += 1;
        refs.push({
          id: `web-annotation-${citationIdx}`,
          sourceTitle: c.title?.trim() || this.buildUrlTitle(c.url),
          sourceUrl: c.url.trim(),
        });
      }
      if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
        for (const r of b.content) {
          if (typeof r.url !== 'string' || !r.url.trim()) continue;
          sourceIdx += 1;
          refs.push({
            id: `web-source-${sourceIdx}`,
            sourceTitle: r.title?.trim() || this.buildUrlTitle(r.url),
            sourceUrl: r.url.trim(),
          });
        }
      }
    }
    const contextReferences = this.capContextReferences(
      this.dedupeReferences(refs),
      MAX_RETURNED_REFERENCES,
    );

    if (!answer) {
      throw new Error('Anthropic web search returned empty answer');
    }

    return {
      answer,
      references: contextReferences.map((reference) => ({
        source: 'web',
        title: reference.sourceTitle ?? 'Web source',
        uri: reference.sourceUrl,
        snippet: reference.snippet,
      })),
      contextReferences,
      provider: 'anthropic-web-search',
      model,
    };
  }

  private getAnthropicApiKey(): string {
    return this.configService
      .get<string>('integrations.llm.anthropicApiKey', '')
      .trim();
  }

  /**
   * Annotation refs (URLs cited inline) outrank search-call refs (the long
   * tail of pages the tool merely visited). We always keep all annotation
   * refs, then top up from search-call refs only up to `cap`.
   */
  private capContextReferences(
    refs: WebSearchContextReference[],
    cap: number,
  ): WebSearchContextReference[] {
    if (refs.length <= cap) return refs;
    const cited = refs.filter((r) => r.id?.startsWith('web-annotation-'));
    if (cited.length >= cap) return cited.slice(0, cap);
    const remaining = cap - cited.length;
    const others = refs.filter((r) => !r.id?.startsWith('web-annotation-'));
    return [...cited, ...others.slice(0, remaining)];
  }

  private async createResponse(
    input: WebSearchQueryInput,
  ): Promise<ResponsesApiPayload> {
    const model = this.getModel();
    const body: Record<string, unknown> = {
      model,
      tool_choice: 'auto',
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
      max_tool_calls: MAX_WEB_SEARCH_TOOL_CALLS,
      input: this.buildInputPrompt(input),
    };

    if (this.supportsReasoningEffort(model)) {
      body.reasoning = { effort: 'low' };
    }

    const response = await fetch(this.buildResponsesUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json()) as ResponsesApiPayload;

    if (!response.ok) {
      const message =
        payload?.error?.message?.trim() ||
        `OpenAI Responses request failed: ${response.status} ${response.statusText}`;

      this.logger.warn(`OpenAI web search request failed: ${message}`);
      throw new ServiceUnavailableException(
        'OpenAI web search is temporarily unavailable.',
      );
    }

    return payload;
  }

  private buildInputPrompt(input: WebSearchQueryInput): string {
    const localeHint = input.locale?.trim()
      ? `Answer in ${input.locale.trim()} if that matches the user's language.`
      : 'Infer the answer language from the user question.';

    const vesselContext = input.vesselContext?.trim()
      ? input.vesselContext.trim()
      : 'The vessel under management (specific identity not provided in this call).';

    return [
      'You are answering a question about a specific vessel and its equipment.',
      '',
      'VESSEL CONTEXT (use as the scope for every answer):',
      vesselContext,
      '',
      'SEARCH BUDGET — STRICT:',
      `- You have AT MOST ${MAX_WEB_SEARCH_TOOL_CALLS} web_search calls. Make them count.`,
      '- Use TARGETED queries: brand + model + topic, or regulation code + topic. Avoid broad queries ("water consumption on ships") that drown the result in tangentially-related material.',
      '- If the first 1-2 searches do not surface a manufacturer page, a classification-society document (RINA / DNV / ABS / Lloyd\'s / BV / CCS), an IMO/ISO standard, or an established marine engineering reference, STOP searching and tell the user you could not find on-point sources. Do NOT keep searching to pad the answer with low-quality material.',
      '',
      'CITATION RULES:',
      '- Cite AT MOST 3 sources, all on-point. Quality over quantity. A 2-source answer that cites manufacturer + class society beats a 10-source answer that includes Wikipedia, brokerage listings, Gutenberg, or encyclopedia summaries.',
      '- DO NOT cite information about UNRELATED VESSELS (LNG carriers, podded ferries, random yacht brokerage listings, Project Gutenberg, generic encyclopedia entries) just because keywords overlap. If on-point sources are absent, say so honestly.',
      '- Prefer the manufacturer\'s own datasheet / manual page for a named component.',
      '',
      'ANSWER FORMAT:',
      '- 1-2 short paragraphs. No bullet lists unless directly useful. No filler.',
      '- Always state the limitation: "This is from public sources, not the vessel\'s own manual or PMS."',
      '- DO NOT request the vessel name from the user — use the vessel context above. If the context is thin, answer in generic marine engineering terms and flag that explicitly.',
      '',
      localeHint,
      '',
      `Question: ${input.question.trim()}`,
    ].join('\n');
  }

  private extractAnswer(payload: ResponsesApiPayload): string | null {
    const contentItems = this.getMessageContentItems(payload);
    const text = contentItems
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text?.trim() ?? '')
      .filter(Boolean)
      .join('\n')
      .trim();

    return text || null;
  }

  private extractContextReferences(
    payload: ResponsesApiPayload,
  ): WebSearchContextReference[] {
    const annotationReferences = this.extractAnnotationReferences(payload);
    const searchCallReferences = this.extractSearchCallReferences(payload);

    return this.dedupeReferences([
      ...annotationReferences,
      ...searchCallReferences,
    ]);
  }

  private extractAnnotationReferences(
    payload: ResponsesApiPayload,
  ): WebSearchContextReference[] {
    const references: WebSearchContextReference[] = [];

    for (const [contentIndex, item] of this.getMessageContentItems(payload).entries()) {
      const annotations = Array.isArray(item.annotations) ? item.annotations : [];

      for (const [annotationIndex, annotation] of annotations.entries()) {
        if (
          annotation?.type !== 'url_citation' ||
          typeof annotation.url !== 'string' ||
          !annotation.url.trim()
        ) {
          continue;
        }

        references.push({
          id: `web-annotation-${contentIndex + 1}-${annotationIndex + 1}`,
          sourceTitle:
            typeof annotation.title === 'string' && annotation.title.trim()
              ? annotation.title.trim()
              : this.buildUrlTitle(annotation.url),
          sourceUrl: annotation.url.trim(),
        });
      }
    }

    return references;
  }

  private extractSearchCallReferences(
    payload: ResponsesApiPayload,
  ): WebSearchContextReference[] {
    const references: WebSearchContextReference[] = [];
    const outputItems = Array.isArray(payload.output) ? payload.output : [];

    for (const [itemIndex, item] of outputItems.entries()) {
      if (item?.type !== 'web_search_call') {
        continue;
      }

      const sources = Array.isArray(item.action?.sources) ? item.action.sources : [];

      for (const [sourceIndex, source] of sources.entries()) {
        if (
          source?.type !== 'url' ||
          typeof source.url !== 'string' ||
          !source.url.trim()
        ) {
          continue;
        }

        references.push({
          id: `web-source-${itemIndex + 1}-${sourceIndex + 1}`,
          sourceTitle: this.buildUrlTitle(source.url),
          sourceUrl: source.url.trim(),
        });
      }
    }

    return references;
  }

  private getMessageContentItems(
    payload: ResponsesApiPayload,
  ): ResponsesApiMessageContentItem[] {
    const outputItems = Array.isArray(payload.output) ? payload.output : [];

    return outputItems
      .filter((item) => item?.type === 'message')
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []));
  }

  private dedupeReferences(
    references: WebSearchContextReference[],
  ): WebSearchContextReference[] {
    const seen = new Set<string>();
    const deduped: WebSearchContextReference[] = [];

    for (const reference of references) {
      const key = reference.sourceUrl?.trim() || reference.sourceTitle?.trim();

      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push(reference);
    }

    return deduped;
  }

  private buildUrlTitle(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./i, '');
    } catch {
      return 'Web source';
    }
  }

  private getApiKey(): string {
    return (
      this.configService
        .get<string>('integrations.webSearch.apiKey', '')
        .trim() ||
      this.configService.get<string>('integrations.llm.apiKey', '').trim()
    );
  }

  private getBaseUrl(): string {
    return (
      this.configService
        .get<string>('integrations.webSearch.baseUrl', '')
        .trim() || 'https://api.openai.com/v1'
    );
  }

  private buildResponsesUrl(): string {
    const baseUrl = this.getBaseUrl().replace(/\/+$/, '');
    return baseUrl.endsWith('/responses') ? baseUrl : `${baseUrl}/responses`;
  }

  private getModel(): string {
    return this.configService
      .get<string>('integrations.webSearch.model', 'gpt-5-mini')
      .trim();
  }

  private supportsReasoningEffort(model: string): boolean {
    const normalized = model.trim().toLowerCase();

    return /^(?:gpt-5|o[134])\b/u.test(normalized);
  }
}
