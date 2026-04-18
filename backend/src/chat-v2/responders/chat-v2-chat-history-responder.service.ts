import { Injectable } from '@nestjs/common';
import { AssistantCanonicalCopyService } from '../../assistant-text/assistant-canonical-copy.service';
import { AssistantFallbackWriterService } from '../../assistant-text/assistant-fallback-writer.service';
import { AssistantTextLocalizerService } from '../../assistant-text/assistant-text-localizer.service';
import { ChatV2TurnContext } from '../context/chat-v2-turn-context.types';
import { ChatV2TaskRoute } from '../routing/chat-v2-task-route.types';

@Injectable()
export class ChatV2ChatHistoryResponderService {
  constructor(
    private readonly copy: AssistantCanonicalCopyService,
    private readonly localizer: AssistantTextLocalizerService,
    private readonly fallbackWriter: AssistantFallbackWriterService,
  ) {}

  async respond(params: {
    turnContext: ChatV2TurnContext;
    route: ChatV2TaskRoute;
    language?: string | null;
  }): Promise<{ content: string }> {
    const { turnContext, route, language } = params;

    switch (route.historyIntent) {
      case 'latest_user_message_before_current':
      case 'previous_user_question_before_current':
        return {
          content: await this.formatMessageRecall({
            language,
            userQuery: turnContext.userQuery,
            message: turnContext.latestUserMessageBeforeCurrent?.content,
            successLabel: 'user',
          }),
        };
      case 'latest_assistant_message_before_current':
        return {
          content: await this.formatMessageRecall({
            language,
            userQuery: turnContext.userQuery,
            message: turnContext.latestAssistantMessageBeforeCurrent?.content,
            successLabel: 'assistant',
          }),
        };
      case 'conversation_summary':
        return {
          content: await this.formatClarification({
            language,
            userQuery: turnContext.userQuery,
          }),
        };
      case 'unknown':
      default:
        return {
          content: await this.formatClarification({
            language,
            userQuery: turnContext.userQuery,
          }),
        };
    }
  }

  private formatMessageRecall(params: {
    language?: string | null;
    userQuery: string;
    message?: string;
    successLabel: 'user' | 'assistant';
  }): Promise<string> {
    const { language, userQuery, message, successLabel } = params;
    const canonical = !message?.trim()
      ? successLabel === 'user'
        ? this.copy.t('chat_history.no_previous_user_message')
        : this.copy.t('chat_history.no_previous_assistant_message')
      : successLabel === 'user'
        ? this.copy.t('chat_history.previous_user_message', {
            message: message.trim(),
          })
        : this.copy.t('chat_history.previous_assistant_message', {
            message: message.trim(),
          });

    return this.localizer.localize({
      language,
      canonicalText: canonical,
      userQuery,
    });
  }

  private formatClarification(params: {
    language?: string | null;
    userQuery: string;
  }): Promise<string> {
    return this.fallbackWriter.write({
      language: params.language,
      key: 'chat_history.clarification',
      userQuery: params.userQuery,
    });
  }
}
