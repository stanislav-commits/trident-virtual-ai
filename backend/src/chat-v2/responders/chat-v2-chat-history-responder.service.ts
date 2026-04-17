import { Injectable } from '@nestjs/common';
import { ChatV2Language } from '../chat-v2.types';
import { ChatV2TurnContext } from '../context/chat-v2-turn-context.types';
import { ChatV2TaskRoute } from '../routing/chat-v2-task-route.types';

@Injectable()
export class ChatV2ChatHistoryResponderService {
  respond(params: {
    turnContext: ChatV2TurnContext;
    route: ChatV2TaskRoute;
    language: ChatV2Language;
  }): { content: string } {
    const { turnContext, route, language } = params;

    switch (route.historyIntent) {
      case 'latest_user_message_before_current':
      case 'previous_user_question_before_current':
        return {
          content: this.formatMessageRecall({
            language,
            message: turnContext.latestUserMessageBeforeCurrent?.content,
            successLabel: 'user',
          }),
        };
      case 'latest_assistant_message_before_current':
        return {
          content: this.formatMessageRecall({
            language,
            message: turnContext.latestAssistantMessageBeforeCurrent?.content,
            successLabel: 'assistant',
          }),
        };
      case 'conversation_summary':
        return {
          content: this.formatClarification(language),
        };
      case 'unknown':
      default:
        return {
          content: this.formatClarification(language),
        };
    }
  }

  private formatMessageRecall(params: {
    language: ChatV2Language;
    message?: string;
    successLabel: 'user' | 'assistant';
  }): string {
    const { language, message, successLabel } = params;

    if (!message?.trim()) {
      switch (language) {
        case 'uk':
          return successLabel === 'user'
            ? 'У цьому чаті ще немає твоїх попередніх повідомлень.'
            : 'У цьому чаті ще немає моїх попередніх відповідей.';
        case 'ru':
          return successLabel === 'user'
            ? 'В этом чате пока нет твоих предыдущих сообщений.'
            : 'В этом чате пока нет моих предыдущих ответов.';
        case 'it':
          return successLabel === 'user'
            ? 'In questa chat non ci sono ancora tuoi messaggi precedenti.'
            : 'In questa chat non ci sono ancora mie risposte precedenti.';
        case 'en':
        case 'unknown':
        default:
          return successLabel === 'user'
            ? 'There are no earlier messages from you in this chat yet.'
            : 'There are no earlier assistant replies in this chat yet.';
      }
    }

    const trimmedMessage = message.trim();
    switch (language) {
      case 'uk':
        return successLabel === 'user'
          ? `Твоє попереднє повідомлення було: "${trimmedMessage}".`
          : `Моя попередня відповідь була: "${trimmedMessage}".`;
      case 'ru':
        return successLabel === 'user'
          ? `Твоё предыдущее сообщение было: "${trimmedMessage}".`
          : `Мой предыдущий ответ был: "${trimmedMessage}".`;
      case 'it':
        return successLabel === 'user'
          ? `Il tuo messaggio precedente era: "${trimmedMessage}".`
          : `La mia risposta precedente era: "${trimmedMessage}".`;
      case 'en':
      case 'unknown':
      default:
        return successLabel === 'user'
          ? `Your previous message was: "${trimmedMessage}".`
          : `My previous reply was: "${trimmedMessage}".`;
    }
  }

  private formatClarification(language: ChatV2Language): string {
    switch (language) {
      case 'uk':
        return 'Я зрозумів, що ти питаєш про історію цього чату, але не зміг точно визначити, чи тобі потрібне твоє попереднє повідомлення, моя попередня відповідь, чи короткий summary.';
      case 'ru':
        return 'Я понял, что ты спрашиваешь об истории этого чата, но не смог точно определить, нужен ли тебе твой предыдущий текст, мой предыдущий ответ или краткое summary.';
      case 'it':
        return 'Ho capito che stai chiedendo della cronologia di questa chat, ma non ho capito con precisione se vuoi il tuo messaggio precedente, la mia risposta precedente o un breve riepilogo.';
      case 'en':
      case 'unknown':
      default:
        return 'I understood this as a chat-history request, but I could not tell whether you wanted your previous message, my previous reply, or a short summary of this chat.';
    }
  }
}
