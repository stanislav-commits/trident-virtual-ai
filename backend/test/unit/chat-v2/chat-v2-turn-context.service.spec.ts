import { ChatV2TurnContextService } from '../../../src/chat-v2/context/chat-v2-turn-context.service';

describe('ChatV2TurnContextService', () => {
  it('excludes the current persisted user turn from previousMessages', async () => {
    const prisma = {
      chatSession: {
        findUnique: jest.fn().mockResolvedValue({
          messages: [
            {
              role: 'user',
              content: 'яке було моє останнє повідомлення',
              ragflowContext: null,
            },
            {
              role: 'assistant',
              content: 'Привіт! Як справи?',
              ragflowContext: { llmResponseId: 'resp_1' },
            },
            {
              role: 'user',
              content: 'Привіт',
              ragflowContext: null,
            },
          ],
        }),
      },
    } as any;

    const service = new ChatV2TurnContextService(prisma);

    const context = await service.buildTurnContext({
      sessionId: 'session-1',
      userQuery: 'яке було моє останнє повідомлення',
    });

    expect(context.previousMessages).toHaveLength(2);
    expect(context.latestUserMessageBeforeCurrent?.content).toBe('Привіт');
    expect(context.latestAssistantMessageBeforeCurrent?.content).toBe(
      'Привіт! Як справи?',
    );
    expect(context.latestAssistantLlmResponseId).toBe('resp_1');
  });

  it('extracts active pending clarification from the latest assistant message', async () => {
    const prisma = {
      chatSession: {
        findUnique: jest.fn().mockResolvedValue({
          messages: [
            {
              role: 'user',
              content: 'які ти знайшов',
              ragflowContext: null,
            },
            {
              role: 'assistant',
              content: 'Я знайшов кілька схожих метрик...',
              ragflowContext: {
                pendingClarification: {
                  id: 'clar-1',
                  domain: 'metrics_v2',
                  kind: 'ambiguous_metrics',
                  language: 'uk',
                  question: 'Яку саме ти маєш на увазі?',
                  originalUserQuery: 'Яка швидкість поточна яхти',
                  createdAtIso: '2026-04-17T18:00:00.000Z',
                  options: [
                    {
                      id: 'opt-1',
                      label: 'Speed Over Ground',
                      metricKey: 'nav.sog',
                      source: 'current',
                    },
                  ],
                },
              },
            },
            {
              role: 'user',
              content: 'Яка швидкість поточна яхти',
              ragflowContext: null,
            },
          ],
        }),
      },
    } as any;

    const service = new ChatV2TurnContextService(prisma);

    const context = await service.buildTurnContext({
      sessionId: 'session-1',
      userQuery: 'які ти знайшов',
    });

    expect(context.activeClarification).toEqual({
      id: 'clar-1',
      domain: 'metrics_v2',
      kind: 'ambiguous_metrics',
      language: 'uk',
      question: 'Яку саме ти маєш на увазі?',
      originalUserQuery: 'Яка швидкість поточна яхти',
      createdAtIso: '2026-04-17T18:00:00.000Z',
      options: [
        {
          id: 'opt-1',
          label: 'Speed Over Ground',
          metricKey: 'nav.sog',
          source: 'current',
        },
      ],
    });
  });
});
