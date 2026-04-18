import { ChatV2ChatHistoryResponderService } from '../../../src/chat-v2/responders/chat-v2-chat-history-responder.service';
import { AssistantCanonicalCopyService } from '../../../src/assistant-text/assistant-canonical-copy.service';

describe('ChatV2ChatHistoryResponderService', () => {
  let service: ChatV2ChatHistoryResponderService;

  beforeEach(() => {
    const localizer = {
      localize: jest.fn(async ({ canonicalText }: { canonicalText: string }) => {
        if (
          canonicalText ===
          'There are no earlier messages from you in this chat yet.'
        ) {
          return 'У цьому чаті ще немає твоїх попередніх повідомлень.';
        }
        if (canonicalText.startsWith('Your previous message was: "')) {
          const message = canonicalText.slice(
            'Your previous message was: "'.length,
            -2,
          );
          return `Твоє попереднє повідомлення було: "${message}".`;
        }
        if (canonicalText.startsWith('My previous reply was: "')) {
          const message = canonicalText.slice(
            'My previous reply was: "'.length,
            -2,
          );
          return `Моя попередня відповідь була: "${message}".`;
        }

        return canonicalText;
      }),
    };
    const fallbackWriter = {
      write: jest.fn(async () => 'Потрібне невелике уточнення по історії чату.'),
    };

    service = new ChatV2ChatHistoryResponderService(
      new AssistantCanonicalCopyService(),
      localizer as any,
      fallbackWriter as any,
    );
  });

  it('returns no-prior-message text when there is no earlier user message', async () => {
    const result = await service.respond({
      turnContext: {
        sessionId: 'session-1',
        userQuery: 'яке було моє останнє повідомлення',
        messageHistory: [],
        previousMessages: [],
      },
      route: {
        domain: 'chat_history',
        confidence: 0.95,
        shipRelated: false,
        needsFreshExternalData: false,
        reason: 'history',
        historyIntent: 'latest_user_message_before_current',
      },
      language: 'uk',
    });

    expect(result.content).toContain('ще немає твоїх попередніх повідомлень');
  });

  it('returns the previous user message from chat history', async () => {
    const result = await service.respond({
      turnContext: {
        sessionId: 'session-1',
        userQuery: 'яке було моє останнє повідомлення',
        messageHistory: [],
        previousMessages: [],
        latestUserMessageBeforeCurrent: {
          role: 'user',
          content: 'Все, добре. Яка сьогодні погода в Польщі',
        },
      },
      route: {
        domain: 'chat_history',
        confidence: 0.95,
        shipRelated: false,
        needsFreshExternalData: false,
        reason: 'history',
        historyIntent: 'latest_user_message_before_current',
      },
      language: 'uk',
    });

    expect(result.content).toContain(
      'Все, добре. Яка сьогодні погода в Польщі',
    );
  });

  it('returns the previous assistant reply when asked', async () => {
    const result = await service.respond({
      turnContext: {
        sessionId: 'session-1',
        userQuery: 'що ти щойно сказав',
        messageHistory: [],
        previousMessages: [],
        latestAssistantMessageBeforeCurrent: {
          role: 'assistant',
          content: 'Привіт! Як справи?',
        },
      },
      route: {
        domain: 'chat_history',
        confidence: 0.95,
        shipRelated: false,
        needsFreshExternalData: false,
        reason: 'history',
        historyIntent: 'latest_assistant_message_before_current',
      },
      language: 'uk',
    });

    expect(result.content).toContain('Привіт! Як справи?');
  });
});
