import { Injectable } from '@nestjs/common';
import { ChatLlmService } from '../chat-llm.service';
import { formatConversationContext } from '../context/chat-context-prompt.utils';
import { ChatConversationContext } from '../context/chat-conversation-context.types';
import { ChatCapabilityRegistryService } from './chat-capability-registry.service';
import { ChatMetricsAskTimeMode } from './chat-metrics-ask-time-mode.enum';
import { parseJsonObject } from './chat-turn-json.utils';
import {
  ChatTurnClassification,
  ChatTurnClassificationAsk,
} from './chat-turn-classifier.types';
import { ChatTurnIntent } from './chat-turn-intent.enum';

@Injectable()
export class ChatTurnClassifierService {
  constructor(
    private readonly chatLlmService: ChatLlmService,
    private readonly chatCapabilityRegistryService: ChatCapabilityRegistryService,
  ) {}

  async classify(
    context: ChatConversationContext,
  ): Promise<ChatTurnClassification> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(context);
    const rawResult = await this.chatLlmService.completeText({
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 320,
    });

    const parsed = this.parseClassification(rawResult);

    if (parsed) {
      return parsed;
    }

    const fallbackQuestion =
      context.latestUserMessage?.content.trim() || 'Continue the conversation.';

    return {
      asks: [
        {
          intent: ChatTurnIntent.SMALL_TALK,
          question: fallbackQuestion,
          timeMode: null,
          timestamp: null,
          rangeStart: null,
          rangeEnd: null,
        },
      ],
      responseLanguage: null,
      reasoning:
        'Classifier output was unavailable or invalid, so the turn fell back to general conversation.',
    };
  }

  private buildSystemPrompt(): string {
    const capabilities = this.chatCapabilityRegistryService
      .getDefinitions()
      .map(
        (definition) =>
          `- ${definition.intent}: ${definition.label} (currently ${definition.enabled ? 'enabled' : 'disabled'})`,
      )
      .join('\n');

    return [
      'You classify the latest user turn for the Trident backend.',
      'Break the latest user turn into one or more concrete asks that the backend should handle.',
      'Use the full recent conversation for context, especially for follow-up questions.',
      'Do not answer the user. Only plan the asks.',
      'Return between 1 and 3 asks.',
      'Each ask must be standalone and self-contained.',
      'If the user combines multiple requests in one message, split them into separate asks in the original order.',
      'Use small_talk only when the turn is general conversation and there is no specific source-backed ask to execute.',
      'For metrics asks, set timeMode to one of snapshot, point_in_time, or range.',
      'For point_in_time metrics asks, provide an ISO timestamp only if you can infer it reliably; otherwise leave timestamp null.',
      'For range metrics asks, provide ISO rangeStart and rangeEnd when you can infer them reliably; otherwise leave them null.',
      'For non-metrics asks, set timeMode to null and timestamp/rangeStart/rangeEnd to null.',
      'Allowed intents:',
      capabilities,
      'Intent guidance:',
      '- small_talk: normal conversation, brainstorming, writing help, or general assistant use without a Trident-specific source.',
      '- web_search: public-information or general knowledge question where a web/public answer is appropriate.',
      '- documentation: questions about product/platform docs, references, guides, or knowledge-base content.',
      '- manuals: questions about vessel manuals, technical instructions, chapters, pages, or ship PDFs.',
      '- live_metrics: questions about current telemetry, current values, current vessel state, or live operational metrics.',
      '- historical_metrics: questions about trends, history, comparisons over time, aggregates, or metrics across a period.',
      'Return only raw JSON with this exact shape:',
      '{"asks":[{"intent":"small_talk|web_search|documentation|manuals|live_metrics|historical_metrics","question":"standalone string","timeMode":"snapshot|point_in_time|range|null","timestamp":"ISO string or null","rangeStart":"ISO string or null","rangeEnd":"ISO string or null"}],"responseLanguage":"string or null","reasoning":"short string"}',
      'responseLanguage must be the language the assistant should use for the final reply, inferred from the user and conversation context.',
      'Do not wrap JSON in markdown.',
    ].join('\n');
  }

  private buildUserPrompt(context: ChatConversationContext): string {
    return [
      'Classify the latest user turn from this conversation transcript.',
      '',
      formatConversationContext(context),
    ].join('\n');
  }

  private parseClassification(
    rawResult: string | null,
  ): ChatTurnClassification | null {
    const parsed = parseJsonObject(rawResult);

    if (!parsed) {
      return null;
    }

    const asks = this.parseAsks(parsed.asks);

    if (asks.length === 0) {
      return null;
    }

    const reasoning =
      typeof parsed.reasoning === 'string' && parsed.reasoning.trim().length > 0
        ? parsed.reasoning.trim()
        : 'The classifier selected the closest supported intent.';

    const responseLanguage =
      typeof parsed.responseLanguage === 'string' &&
      parsed.responseLanguage.trim().length > 0
        ? parsed.responseLanguage.trim()
        : null;

    return {
      asks,
      responseLanguage,
      reasoning,
    };
  }

  private parseAsks(value: unknown): ChatTurnClassificationAsk[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((entry) => this.parseAsk(entry))
      .filter((entry): entry is ChatTurnClassificationAsk => entry !== null)
      .slice(0, 3);
  }

  private parseAsk(value: unknown): ChatTurnClassificationAsk | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const entry = value as Record<string, unknown>;
    const intent =
      typeof entry.intent === 'string' && this.isSupportedIntent(entry.intent)
        ? entry.intent
        : null;
    const question =
      typeof entry.question === 'string' && entry.question.trim().length > 0
        ? entry.question.trim()
        : null;

    if (!intent || !question) {
      return null;
    }

    const parsedTimeMode =
      typeof entry.timeMode === 'string'
        ? this.parseTimeMode(entry.timeMode)
        : null;
    const timestamp =
      typeof entry.timestamp === 'string' && entry.timestamp.trim().length > 0
        ? entry.timestamp.trim()
        : null;
    const rangeStart =
      typeof entry.rangeStart === 'string' && entry.rangeStart.trim().length > 0
        ? entry.rangeStart.trim()
        : null;
    const rangeEnd =
      typeof entry.rangeEnd === 'string' && entry.rangeEnd.trim().length > 0
        ? entry.rangeEnd.trim()
        : null;

    return {
      intent,
      question,
      timeMode: parsedTimeMode,
      timestamp,
      rangeStart,
      rangeEnd,
    };
  }

  private parseTimeMode(value: string): ChatMetricsAskTimeMode | null {
    if (Object.values(ChatMetricsAskTimeMode).includes(value as ChatMetricsAskTimeMode)) {
      return value as ChatMetricsAskTimeMode;
    }

    return null;
  }

  private isSupportedIntent(value: string): value is ChatTurnIntent {
    return Object.values(ChatTurnIntent).includes(value as ChatTurnIntent);
  }
}
