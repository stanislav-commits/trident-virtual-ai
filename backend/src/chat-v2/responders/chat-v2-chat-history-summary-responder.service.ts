import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AssistantCanonicalCopyService } from '../../assistant-text/assistant-canonical-copy.service';
import { AssistantTextLocalizerService } from '../../assistant-text/assistant-text-localizer.service';
import OpenAI from 'openai';
import { ChatV2TurnClassification } from '../chat-v2.types';
import { ChatV2TurnContext } from '../context/chat-v2-turn-context.types';

@Injectable()
export class ChatV2ChatHistorySummaryResponderService {
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(
    private readonly copy: AssistantCanonicalCopyService,
    private readonly localizer: AssistantTextLocalizerService,
  ) {
    const apiKey = process.env.OPENAI_API_KEY;
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.model =
      process.env.CHAT_V2_HISTORY_SUMMARY_MODEL ||
      process.env.LLM_MODEL ||
      'gpt-4o-mini';
  }

  async respond(params: {
    turnContext: ChatV2TurnContext;
    classification: ChatV2TurnClassification;
  }): Promise<{ content: string; responseId?: string }> {
    const { turnContext, classification } = params;

    if (turnContext.previousMessages.length === 0) {
      return {
        content: await this.localizer.localize({
          language: classification.language,
          canonicalText: this.copy.t('chat_history.summary_empty'),
          userQuery: turnContext.userQuery,
        }),
      };
    }

    try {
      if (!this.client) {
        throw new Error('OPENAI_API_KEY is not set');
      }

      const response = await this.client.responses.create({
        model: this.model,
        temperature: 0.2,
        max_output_tokens: 260,
        instructions:
          'You are summarizing the current chat only. ' +
          'Use ONLY the provided chat history as the source of truth. ' +
          'Do not invent facts, do not add anything that is not present in the chat, and do not mention external knowledge. ' +
          'Write a concise, natural summary in the user language. ' +
          `Preferred language signal: ${classification.language}.`,
        input: [
          {
            role: 'user',
            content:
              'Summarize this chat briefly.\n\n' +
              this.formatChatHistory(turnContext),
          },
        ],
      });

      const content = response.output_text?.trim();
      if (!content) {
        throw new Error('Empty response from chat history summary');
      }

      return {
        content,
        responseId: response.id,
      };
    } catch (error) {
      throw new ServiceUnavailableException(
        `Chat v2 history summary failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private formatChatHistory(turnContext: ChatV2TurnContext): string {
    return turnContext.previousMessages
      .filter((message) => message.content.trim())
      .map((message) => `${message.role}: ${message.content.trim()}`)
      .join('\n');
  }
}
