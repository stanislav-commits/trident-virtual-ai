import { Injectable } from '@nestjs/common';
import { LlmService } from '../../integrations/llm/llm.service';
import { formatConversationContext } from './context/chat-context-prompt.utils';
import { ChatConversationContext } from './context/chat-conversation-context.types';
import { ChatMessageRole } from './enums/chat-message-role.enum';
import { ChatMessageEntity } from './entities/chat-message.entity';
import { ChatSessionEntity } from './entities/chat-session.entity';
import { ChatTurnAskResult } from './responders/interfaces/chat-turn-responder.types';

interface GenerateChatReplyInput {
  session: ChatSessionEntity;
  context: ChatConversationContext;
}

interface ChatTextCompletionInput {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
}

@Injectable()
export class ChatLlmService {
  constructor(private readonly llmService: LlmService) {}

  async completeText(input: ChatTextCompletionInput): Promise<string | null> {
    return this.llmService.createChatCompletion({
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
    });
  }

  async generateConversationReply(
    input: GenerateChatReplyInput,
  ): Promise<string> {
    const systemPrompt = this.buildConversationSystemPrompt(input.session);
    const userPrompt = this.buildConversationUserPrompt(input.context);

    const reply = await this.completeText({
      systemPrompt,
      userPrompt,
      temperature: 0.6,
      maxTokens: 700,
    });

    if (reply) {
      return reply;
    }

    return this.buildFallbackReply(input.context.allMessages);
  }

  async generateUnavailableCapabilityReply(input: {
    capabilityLabel: string;
    responseLanguage: string | null;
  }): Promise<string> {
    const reply = await this.completeText({
      systemPrompt: [
        'You are the Trident assistant.',
        'The requested product capability is not connected yet.',
        'Briefly explain that it is still in development and mention that regular conversation and public-information questions are already available.',
        'Use the user language hinted below if it is provided.',
      ].join(' '),
      userPrompt: [
        `Requested capability: ${input.capabilityLabel}`,
        `Preferred response language: ${input.responseLanguage ?? 'infer from context if possible'}`,
      ].join('\n'),
      temperature: 0.2,
      maxTokens: 180,
    });

    if (reply) {
      return reply;
    }

    return `The ${input.capabilityLabel} capability is still in development. I can already help with general conversation and public-information questions.`;
  }

  async composeAskResultsReply(input: {
    context: ChatConversationContext;
    responseLanguage: string | null;
    askResults: ChatTurnAskResult[];
  }): Promise<string> {
    const reply = await this.completeText({
      systemPrompt: [
        'You are the Trident assistant.',
        'Compose one final reply using only the structured ask results provided.',
        'Do not invent metrics, timestamps, sources, facts, or conclusions that are not present in the ask results.',
        'Do not mention missing, unavailable, or failed topics unless they explicitly appear in the structured ask results.',
        'Do not infer extra sub-questions from the conversation history.',
        'If one ask is unavailable or still in development, say that clearly and continue with the rest.',
        'Keep the reply natural and concise.',
        'Use the requested response language if it is provided.',
      ].join(' '),
      userPrompt: [
        `Latest user message: ${input.context.latestUserMessage?.content ?? 'unknown'}`,
        '',
        `Preferred response language: ${input.responseLanguage ?? 'infer from latest user message'}`,
        '',
        'Structured ask results:',
        JSON.stringify(input.askResults, null, 2),
      ].join('\n'),
      temperature: 0.2,
      maxTokens: 900,
    });

    if (reply) {
      return reply;
    }

    return input.askResults.map((result) => result.summary).join('\n\n');
  }

  private buildConversationSystemPrompt(session: ChatSessionEntity): string {
    const shipContext = session.ship
      ? `The active ship context is "${session.ship.name}"${session.ship.organizationName ? ` from organization "${session.ship.organizationName}"` : ''}.`
      : 'There is no active ship context for this chat.';

    return [
      'You are a helpful conversational AI assistant inside the Trident platform.',
      'Reply naturally and continue the conversation without adding citations or extra system markup.',
      'Prefer the same language as the latest user message.',
      shipContext,
    ].join(' ');
  }

  private buildConversationUserPrompt(context: ChatConversationContext): string {
    return [
      'Continue this conversation and write the next assistant reply.',
      '',
      formatConversationContext(context),
    ].join('\n');
  }

  private buildFallbackReply(messages: ChatMessageEntity[]): string {
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === ChatMessageRole.USER);

    if (!lastUserMessage) {
      return 'Hello. The chat is connected, but the language model is temporarily unavailable.';
    }

    return [
      'I received your message, but the language model is temporarily unavailable right now.',
      `Last message: ${this.truncate(lastUserMessage.content.trim(), 240)}`,
    ].join('\n\n');
  }

  private truncate(value: string, limit: number): string {
    if (value.length <= limit) {
      return value;
    }

    return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}...`;
  }
}
