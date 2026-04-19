import { Injectable } from '@nestjs/common';
import { ChatLlmService } from '../chat-llm.service';
import { formatConversationContext } from '../context/chat-context-prompt.utils';
import { ChatConversationContext } from '../context/chat-conversation-context.types';
import { ChatCapabilityRegistryService } from './chat-capability-registry.service';
import { parseJsonObject } from './chat-turn-json.utils';
import { ChatTurnClassification } from './chat-turn-classifier.types';
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

    return {
      intent: ChatTurnIntent.SMALL_TALK,
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
      'Choose exactly one intent that best matches what the user is asking for right now.',
      'Use the full recent conversation for context, especially for follow-up questions.',
      'Do not answer the user. Only classify the turn.',
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
      '{"intent":"small_talk|web_search|documentation|manuals|live_metrics|historical_metrics","responseLanguage":"string or null","reasoning":"short string"}',
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

    const intent =
      typeof parsed.intent === 'string' && this.isSupportedIntent(parsed.intent)
        ? parsed.intent
        : null;

    if (!intent) {
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
      intent,
      responseLanguage,
      reasoning,
    };
  }

  private isSupportedIntent(value: string): value is ChatTurnIntent {
    return Object.values(ChatTurnIntent).includes(value as ChatTurnIntent);
  }
}
