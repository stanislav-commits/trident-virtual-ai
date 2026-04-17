import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';
import { ChatCitation } from '../../chat/chat.types';
import { ChatV2Language } from '../chat-v2.types';
import {
  ChatV2WebSearchProvider,
  ChatV2WebSearchResult,
} from './chat-v2-web-search.provider';

@Injectable()
export class ChatV2OpenAiWebSearchProvider extends ChatV2WebSearchProvider {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor() {
    super();

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    this.client = new OpenAI({ apiKey });
    this.model =
      process.env.CHAT_V2_WEB_MODEL ||
      process.env.LLM_MODEL ||
      'gpt-4o-mini';
  }

  async search(params: {
    query: string;
    originalUserQuery: string;
    language: ChatV2Language;
  }): Promise<ChatV2WebSearchResult> {
    const { query, originalUserQuery, language } = params;
    const responseLanguage = this.getResponseLanguageInstruction(language);

    try {
      const response = await this.client.responses.create({
        model: this.model,
        temperature: 0.2,
        max_output_tokens: 500,
        instructions:
          'You are Trident Intelligence. The user asked a non-ship general question that requires current web information. ' +
          'Always use web search before answering. ' +
          `You must respond strictly in ${responseLanguage}. ` +
          `Preferred language signal: ${language}. ` +
          'Keep the answer concise, grounded in the search results, and include time-sensitive framing when relevant. ' +
          'Do not dump raw URLs, tracking links, or a source list inside the body text. ' +
          'If you mention sources in the answer, refer to them by publisher name only because clickable links are rendered separately in the UI.',
        tools: [
          {
            type: 'web_search_preview',
          },
        ],
        include: ['web_search_call.action.sources'],
        tool_choice: 'auto',
        input: [
          {
            role: 'user',
            content:
              `Original user question: ${originalUserQuery}\n` +
              `Web search query: ${query}\n` +
              `Final answer language: ${responseLanguage}`,
          },
        ],
      });

      const content = response.output_text?.trim();
      if (!content) {
        throw new Error('Empty response from web search');
      }

      const citations = this.extractCitations(response);

      return {
        content,
        responseId: response.id,
        citations,
        webSearchQuery: query,
        sourceCount: citations.length,
      };
    } catch (error) {
      throw new ServiceUnavailableException(
        `Chat v2 web search failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private extractCitations(response: OpenAI.Responses.Response): ChatCitation[] {
    const citations = new Map<string, ChatCitation>();
    const outputItems = Array.isArray((response as any).output)
      ? ((response as any).output as Array<Record<string, unknown>>)
      : [];

    for (const item of outputItems) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const contentItem of item.content as Array<Record<string, unknown>>) {
          const annotations = Array.isArray(contentItem.annotations)
            ? (contentItem.annotations as Array<Record<string, unknown>>)
            : [];

          for (const annotation of annotations) {
            if (annotation.type !== 'url_citation') {
              continue;
            }

            const url =
              typeof annotation.url === 'string' ? annotation.url : undefined;
            const title =
              typeof annotation.title === 'string'
                ? annotation.title
                : url || 'Web source';
            const key = `${title}::${url ?? ''}`;
            citations.set(key, {
              sourceTitle: title,
              sourceUrl: url,
              sourceCategory: 'web',
            });
          }
        }
      }

      if (
        item.type === 'web_search_call' &&
        item.action &&
        typeof item.action === 'object' &&
        Array.isArray((item.action as Record<string, unknown>).sources)
      ) {
        for (const source of (item.action as Record<string, unknown>)
          .sources as Array<Record<string, unknown>>) {
          const url = typeof source.url === 'string' ? source.url : undefined;
          const title =
            typeof source.title === 'string'
              ? source.title
              : url || 'Web source';
          const key = `${title}::${url ?? ''}`;
          if (!citations.has(key)) {
            citations.set(key, {
              sourceTitle: title,
              sourceUrl: url,
              sourceCategory: 'web',
            });
          }
        }
      }
    }

    return [...citations.values()];
  }

  private getResponseLanguageInstruction(language: ChatV2Language): string {
    switch (language) {
      case 'uk':
        return 'Ukrainian';
      case 'ru':
        return 'Russian';
      case 'it':
        return 'Italian';
      case 'en':
      case 'unknown':
      default:
        return 'English';
    }
  }
}
