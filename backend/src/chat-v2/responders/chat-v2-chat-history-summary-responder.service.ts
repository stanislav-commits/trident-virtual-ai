import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';
import { ChatV2TurnClassification } from '../chat-v2.types';
import { ChatV2TurnContext } from '../context/chat-v2-turn-context.types';

@Injectable()
export class ChatV2ChatHistorySummaryResponderService {
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor() {
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
        content: this.buildEmptySummaryResponse(classification.language),
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

  private buildEmptySummaryResponse(language: ChatV2TurnClassification['language']): string {
    switch (language) {
      case 'uk':
        return 'У цьому чаті ще немає попередніх повідомлень, які можна підсумувати.';
      case 'ru':
        return 'В этом чате пока нет предыдущих сообщений, которые можно кратко пересказать.';
      case 'it':
        return 'In questa chat non ci sono ancora messaggi precedenti da riassumere.';
      case 'en':
      case 'unknown':
      default:
        return 'There are no earlier messages in this chat to summarize yet.';
    }
  }
}
