import { Injectable } from '@nestjs/common';
import { ChatLlmService } from '../chat-llm.service';
import { CHAT_CONTEXT_QUERY_REWRITE_MAX_TOKENS } from './chat-context.constants';
import { formatConversationContext } from './chat-context-prompt.utils';
import { ChatConversationContext } from './chat-conversation-context.types';

@Injectable()
export class ChatContextQueryResolverService {
  constructor(private readonly chatLlmService: ChatLlmService) {}

  async resolveStandaloneQuestion(
    context: ChatConversationContext,
    responseLanguage: string | null,
  ): Promise<string> {
    const latestUserMessage = context.latestUserMessage?.content.trim();

    if (!latestUserMessage) {
      return '';
    }

    const rewrittenQuestion = await this.chatLlmService.completeText({
      systemPrompt: [
        'Rewrite the latest user message into a standalone search-ready question.',
        'Use the conversation summary and recent dialogue to resolve pronouns, omitted entities, and follow-up references.',
        'ACTION CONFIRMATIONS — CRITICAL: when the previous assistant turn PROPOSED an action (creating/completing a maintenance task, logging an hours reading) and the latest user message is an explicit confirmation ("yes", "yes, log it", "yes, create it", "confirmed", "go ahead"), the rewritten question MUST (a) restate the exact action with all parameters from the proposal and (b) state explicitly that THE USER HAS ALREADY CONFIRMED it — e.g. "The user explicitly confirmed: log a running-hours reading of 1046 h for Diesel Generator — Port. Log it now." Dropping the already-confirmed fact makes the executing engine re-ask for confirmation in an endless loop.',
        'Do not answer the question.',
        'Return only the rewritten standalone question as plain text.',
      ].join(' '),
      userPrompt: [
        formatConversationContext(context),
        '',
        `Preferred response language: ${responseLanguage ?? 'infer from context'}`,
        `Latest user message: ${latestUserMessage}`,
      ].join('\n'),
      temperature: 0,
      maxTokens: CHAT_CONTEXT_QUERY_REWRITE_MAX_TOKENS,
    });

    return rewrittenQuestion?.trim() || latestUserMessage;
  }
}
