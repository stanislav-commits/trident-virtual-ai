import { ChatV2ChatHistoryResponderService } from '../../../src/chat-v2/responders/chat-v2-chat-history-responder.service';

describe('ChatV2ChatHistoryResponderService', () => {
  let service: ChatV2ChatHistoryResponderService;

  beforeEach(() => {
    service = new ChatV2ChatHistoryResponderService();
  });

  it('returns no-prior-message text when there is no earlier user message', () => {
    const result = service.respond({
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

  it('returns the previous user message from chat history', () => {
    const result = service.respond({
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

  it('returns the previous assistant reply when asked', () => {
    const result = service.respond({
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
