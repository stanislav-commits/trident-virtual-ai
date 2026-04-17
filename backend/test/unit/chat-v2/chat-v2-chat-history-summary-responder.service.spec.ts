import { ChatV2ChatHistorySummaryResponderService } from '../../../src/chat-v2/responders/chat-v2-chat-history-summary-responder.service';

describe('ChatV2ChatHistorySummaryResponderService', () => {
  let service: ChatV2ChatHistorySummaryResponderService;

  beforeEach(() => {
    service = new ChatV2ChatHistorySummaryResponderService();
  });

  it('returns an empty-history summary message without calling LLM when there are no prior messages', async () => {
    const result = await service.respond({
      turnContext: {
        sessionId: 'session-1',
        userQuery: 'Про що ми говорили в цьому чаті',
        messageHistory: [],
        previousMessages: [],
      },
      classification: {
        kind: 'task_request',
        confidence: 0.98,
        language: 'uk',
        reason: 'history summary',
      },
    });

    expect(result.content).toContain(
      'ще немає попередніх повідомлень, які можна підсумувати',
    );
  });
});
