import { Injectable } from '@nestjs/common';
import { ChatLlmService } from '../chat-llm.service';
import { formatConversationContext } from '../context/chat-context-prompt.utils';
import { ChatConversationContext } from '../context/chat-conversation-context.types';
import { ChatCapabilityRegistryService } from './chat-capability-registry.service';
import { ChatMetricsAskTimeMode } from './chat-metrics-ask-time-mode.enum';
import { parseJsonObject } from './chat-turn-json.utils';
import { ChatTurnClassificationAsk } from './chat-turn-classifier.types';
import { ChatTurnIntent } from './chat-turn-intent.enum';

@Injectable()
export class ChatTurnClassifierService {
  constructor(
    private readonly chatLlmService: ChatLlmService,
    private readonly chatCapabilityRegistryService: ChatCapabilityRegistryService,
  ) {}

  async classifyAsk(input: {
    context: ChatConversationContext;
    question: string;
  }): Promise<ChatTurnClassificationAsk> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(input.context, input.question);
    const rawResult = await this.chatLlmService.completeText({
      systemPrompt,
      userPrompt,
      temperature: 0,
      maxTokens: 220,
    });

    const parsed = this.parseClassification(rawResult);

    if (parsed) {
      return parsed;
    }

    return {
      intent: ChatTurnIntent.SMALL_TALK,
      question: input.question.trim() || 'Continue the conversation.',
      timeMode: null,
      timestamp: null,
      rangeStart: null,
      rangeEnd: null,
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
      'You classify one standalone ask for the Trident backend.',
      'The ask has already been decomposed and must not be split further.',
      'Use the full recent conversation for follow-up context.',
      'Do not answer the user. Only classify this one ask.',
      'Use small_talk only when the ask is general conversation and there is no specific source-backed ask to execute.',
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
      '{"intent":"small_talk|web_search|documentation|manuals|live_metrics|historical_metrics","question":"standalone string","timeMode":"snapshot|point_in_time|range|null","timestamp":"ISO string or null","rangeStart":"ISO string or null","rangeEnd":"ISO string or null","reasoning":"short string"}',
      'Do not wrap JSON in markdown.',
    ].join('\n');
  }

  private buildUserPrompt(
    context: ChatConversationContext,
    question: string,
  ): string {
    return [
      'Classify this standalone ask from the latest user turn.',
      '',
      `Standalone ask: ${question}`,
      '',
      formatConversationContext(context),
    ].join('\n');
  }

  private parseClassification(
    rawResult: string | null,
  ): ChatTurnClassificationAsk | null {
    const parsed = parseJsonObject(rawResult);

    if (!parsed) {
      return null;
    }

    const entry = parsed as Record<string, unknown>;
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
