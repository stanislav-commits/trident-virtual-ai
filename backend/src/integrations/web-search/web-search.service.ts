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

/**
 * Caps for the web_search tool. Keeping these tight beats
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
    const active = this.shouldUseAnthropic();
    const mainModel = this.configService
      .get<string>('integrations.llm.model', '')
      .trim();
    return {
      name: 'web-search',
      configured: active,
      reachable: false,
      details: active
        ? `Anthropic native web search, run by the main model ("${mainModel}").`
        : 'Web search needs a Claude main model (LLM_MODEL) and ANTHROPIC_API_KEY.',
    };
  }

  /**
   * Web answers come from Anthropic's server-side web_search tool, run by the
   * SAME model that talks to the user: it formulates the queries, reads the
   * results and writes the answer in its own voice with inline citations.
   *
   * There is no second provider behind it. A detached summary from another
   * model, glued in when the first one failed, is not the same answer with a
   * different logo on it — it reasons differently, cites differently and
   * cannot see the conversation. A failure here surfaces as a failure.
   */
  async search(input: WebSearchQueryInput): Promise<WebSearchResult> {
    if (!this.shouldUseAnthropic()) {
      throw new ServiceUnavailableException(
        'Web search needs a Claude main model and an Anthropic API key.',
      );
    }
    return this.searchViaAnthropic(input);
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
      'SCOPE CHECK — decide this BEFORE searching:',
      '- You are a shipboard AI assistant for OPERATING AND MAINTAINING this specific vessel: telemetry, maintenance/PMS, compliance, defects, crew tasks, and onboard documents. You are NOT a shipyard-management, shipbuilding, or newbuild-project consultant, and you have no special knowledge of running a shipyard business.',
      '- If the question asks you to act as, or describes capabilities for, a DIFFERENT domain than operating/maintaining a vessel (e.g. "what can you do for a shipyard", running a boatyard business, shipbuilding/newbuild project management), do NOT research that industry on the open web. Instead answer briefly: say plainly that you are this vessel\'s AI assistant for operations and maintenance, that shipyard/shipbuilding business questions are outside what you can help with, and mention 1-2 things you CAN actually help with (maintenance planning, compliance status, defects, metrics, onboard documents). Stop there — skip the search budget, citation rules, and answer format below.',
      '- Otherwise, if this is genuine public/reference knowledge relevant to operating or maintaining a vessel (e.g. "what is MARPOL", "what is a bunker delivery note", manufacturer specs, regulations), continue below as normal.',
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
      // No "this is from public sources" line. The crew asked a question and
      // want the answer; where it came from is shown by the sources button,
      // and the sentence was surviving into answers half-eaten by the strip
      // that was meant to remove it (2026-07-31).
      '- Do NOT add a disclaimer about where the information comes from.',
      '- DO NOT request the vessel name from the user — use the vessel context above. If the context is thin, answer in generic marine engineering terms and flag that explicitly.',
      '',
      localeHint,
      '',
      `Question: ${input.question.trim()}`,
    ].join('\n');
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
}
