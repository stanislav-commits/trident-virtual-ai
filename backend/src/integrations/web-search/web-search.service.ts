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

@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);

  constructor(private readonly configService: ConfigService) {}

  getStatus(): IntegrationStatusDto {
    const hasApiKey = Boolean(this.getApiKey());
    return {
      name: 'web-search',
      configured: hasApiKey,
      reachable: false,
      details: hasApiKey
        ? `OpenAI Responses web search is configured with model "${this.getModel()}".`
        : 'WEB_SEARCH_API_KEY or LLM_API_KEY must be configured for OpenAI web search.',
    };
  }

  async search(input: WebSearchQueryInput): Promise<WebSearchResult> {
    if (!this.getApiKey()) {
      throw new ServiceUnavailableException(
        'OpenAI web search is not configured yet.',
      );
    }

    const payload = await this.createResponse(input);
    const answer = this.extractAnswer(payload);
    const contextReferences = this.extractContextReferences(payload);

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

  private async createResponse(
    input: WebSearchQueryInput,
  ): Promise<ResponsesApiPayload> {
    const response = await fetch(this.buildResponsesUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.getModel(),
        reasoning: { effort: 'low' },
        tool_choice: 'auto',
        tools: [{ type: 'web_search' }],
        include: ['web_search_call.action.sources'],
        input: this.buildInputPrompt(input),
      }),
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

    return [
      'Answer the user question using web search.',
      localeHint,
      'Cite relevant sources in the answer.',
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
      .get<string>('integrations.webSearch.model', 'gpt-5.2')
      .trim();
  }
}
