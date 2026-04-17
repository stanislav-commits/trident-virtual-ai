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
});
