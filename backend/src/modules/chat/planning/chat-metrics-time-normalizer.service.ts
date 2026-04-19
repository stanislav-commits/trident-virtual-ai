import { Injectable } from '@nestjs/common';
import { formatConversationContext } from '../context/chat-context-prompt.utils';
import { ChatConversationContext } from '../context/chat-conversation-context.types';
import { ChatLlmService } from '../chat-llm.service';
import { parseJsonObject } from './chat-turn-json.utils';
import { ChatTurnClassificationAsk } from './chat-turn-classifier.types';
import { ChatTurnIntent } from './chat-turn-intent.enum';
import { ChatMetricsAskTimeMode } from './chat-metrics-ask-time-mode.enum';

interface ChatMetricsTimeNormalization {
  question: string;
  timeMode: ChatMetricsAskTimeMode;
  timestamp: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  reasoning: string;
}

@Injectable()
export class ChatMetricsTimeNormalizerService {
  private readonly defaultTimezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  constructor(private readonly chatLlmService: ChatLlmService) {}

  async normalizeAsk(
    ask: ChatTurnClassificationAsk,
    context: ChatConversationContext,
  ): Promise<ChatTurnClassificationAsk> {
    if (!this.isMetricsIntent(ask.intent)) {
      return ask;
    }

    const rawResult = await this.chatLlmService.completeText({
      systemPrompt: this.buildSystemPrompt(),
      userPrompt: this.buildUserPrompt(ask, context),
      temperature: 0,
      maxTokens: 260,
    });
    const normalized = this.parseNormalization(rawResult);

    if (!normalized) {
      return ask;
    }

    return {
      ...ask,
      question: normalized.question,
      timeMode: normalized.timeMode,
      timestamp: normalized.timestamp,
      rangeStart: normalized.rangeStart,
      rangeEnd: normalized.rangeEnd,
    };
  }

  private buildSystemPrompt(): string {
    return [
      'You normalize time semantics for vessel telemetry asks.',
      'Do not answer the user.',
      'Return only raw JSON.',
      'Convert relative time expressions into absolute ISO-8601 timestamps using the provided timezone and reference time.',
      'Preserve the metric subject in the question, but remove or simplify the time phrase so the remaining question focuses on the telemetry concept.',
      'For "now" or current-state asks, use timeMode "snapshot" and set timestamp/rangeStart/rangeEnd to null.',
      'For a specific historical moment such as "5 days ago" or "yesterday at 14:00", use "point_in_time" and set timestamp to one ISO string.',
      'For intervals such as "last 7 days" or "between Monday and Wednesday", use "range" and set rangeStart and rangeEnd.',
      'If a range is implied but an exact boundary cannot be inferred safely, choose the closest reasonable absolute boundaries from the reference time.',
      'Keep the question in the user language when possible.',
      'Return this exact JSON shape:',
      '{"question":"string","timeMode":"snapshot|point_in_time|range","timestamp":"ISO string or null","rangeStart":"ISO string or null","rangeEnd":"ISO string or null","reasoning":"short string"}',
    ].join('\n');
  }

  private buildUserPrompt(
    ask: ChatTurnClassificationAsk,
    context: ChatConversationContext,
  ): string {
    const referenceNow = new Date();

    return [
      `Reference timezone: ${this.defaultTimezone}`,
      `Reference time (ISO): ${referenceNow.toISOString()}`,
      '',
      `Original ask intent: ${ask.intent}`,
      `Original ask question: ${ask.question}`,
      `Classifier timeMode hint: ${ask.timeMode ?? 'null'}`,
      `Classifier timestamp hint: ${ask.timestamp ?? 'null'}`,
      `Classifier rangeStart hint: ${ask.rangeStart ?? 'null'}`,
      `Classifier rangeEnd hint: ${ask.rangeEnd ?? 'null'}`,
      '',
      'Conversation context:',
      formatConversationContext(context),
    ].join('\n');
  }

  private parseNormalization(
    rawResult: string | null,
  ): ChatMetricsTimeNormalization | null {
    const parsed = parseJsonObject(rawResult);

    if (!parsed) {
      return null;
    }

    const question =
      typeof parsed.question === 'string' && parsed.question.trim().length > 0
        ? parsed.question.trim()
        : null;
    const timeMode =
      typeof parsed.timeMode === 'string'
        ? this.parseTimeMode(parsed.timeMode)
        : null;

    if (!question || !timeMode) {
      return null;
    }

    const timestamp = this.normalizeIsoValue(parsed.timestamp);
    const rangeStart = this.normalizeIsoValue(parsed.rangeStart);
    const rangeEnd = this.normalizeIsoValue(parsed.rangeEnd);
    const reasoning =
      typeof parsed.reasoning === 'string' && parsed.reasoning.trim().length > 0
        ? parsed.reasoning.trim()
        : 'The metrics time semantics were normalized.';

    if (timeMode === ChatMetricsAskTimeMode.POINT_IN_TIME && !timestamp) {
      return null;
    }

    if (
      timeMode === ChatMetricsAskTimeMode.RANGE &&
      (!rangeStart || !rangeEnd)
    ) {
      return null;
    }

    return {
      question,
      timeMode,
      timestamp,
      rangeStart,
      rangeEnd,
      reasoning,
    };
  }

  private normalizeIsoValue(value: unknown): string | null {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return null;
    }

    const parsed = new Date(value.trim());

    if (Number.isNaN(parsed.getTime())) {
      return null;
    }

    return parsed.toISOString();
  }

  private parseTimeMode(value: string): ChatMetricsAskTimeMode | null {
    if (
      Object.values(ChatMetricsAskTimeMode).includes(
        value as ChatMetricsAskTimeMode,
      )
    ) {
      return value as ChatMetricsAskTimeMode;
    }

    return null;
  }

  private isMetricsIntent(intent: ChatTurnIntent): boolean {
    return (
      intent === ChatTurnIntent.LIVE_METRICS ||
      intent === ChatTurnIntent.HISTORICAL_METRICS
    );
  }
}
