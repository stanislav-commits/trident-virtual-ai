import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';
import { ChatV2TurnClassification } from '../chat-v2.types';
import {
  ChatV2ConversationMessage,
  ChatV2TurnContext,
} from '../context/chat-v2-turn-context.types';

@Injectable()
export class ChatV2SmallTalkResponderService {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly temperature: number;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set');
    }

    this.client = new OpenAI({ apiKey });
    this.model =
      process.env.CHAT_V2_SMALL_TALK_MODEL ||
      process.env.LLM_MODEL ||
      'gpt-4o-mini';
    this.temperature = Number.parseFloat(
      process.env.CHAT_V2_SMALL_TALK_TEMPERATURE || '0.4',
    );
  }

  async respond(params: {
    turnContext: ChatV2TurnContext;
    classification: ChatV2TurnClassification;
  }): Promise<{ content: string; responseId?: string }> {
    const { turnContext, classification } = params;

    try {
      const response = await this.client.responses.create({
        model: this.model,
        temperature: this.temperature,
        max_output_tokens: 220,
        instructions:
          'You are Trident Intelligence chat assistant. The user is making casual conversation, not asking for vessel data, manuals, metrics, or operational support. ' +
          'Answer naturally, briefly, and in the user language. ' +
          'Use the recent chat history to keep continuity and references coherent. ' +
          'Do not mention documentation, telemetry, vessel systems, or limitations unless the user asks. ' +
          `Preferred language signal: ${classification.language}.`,
        input: this.buildConversationInput(
          turnContext.messageHistory,
          turnContext.userQuery,
        ),
      });

      const content = response.output_text?.trim();
      if (!content) {
        throw new Error('Empty response from LLM');
      }

      return {
        content,
        responseId: response.id,
      };
    } catch (error) {
      throw new ServiceUnavailableException(
        `Chat v2 small-talk generation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private buildConversationInput(
    messageHistory: ChatV2ConversationMessage[],
    userQuery: string,
  ): Array<{
    role: 'user' | 'assistant';
    content: string;
  }> {
    const recentConversation: Array<{
      role: 'user' | 'assistant';
      content: string;
    }> = messageHistory
      .filter((message): message is ChatV2ConversationMessage & {
        role: 'user' | 'assistant';
      } => {
        return (
          (message.role === 'user' || message.role === 'assistant') &&
          Boolean(message.content.trim())
        );
      })
      .map((message) => ({
        role: message.role,
        content: message.content.trim(),
      }))
      .slice(-12);

    if (recentConversation.length > 0) {
      return recentConversation;
    }

    return [
      {
        role: 'user',
        content: userQuery.trim(),
      },
    ];
  }
}
