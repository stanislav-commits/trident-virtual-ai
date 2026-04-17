import { ChatV2TaskRouterService } from '../../../src/chat-v2/routing/chat-v2-task-router.service';

describe('ChatV2TaskRouterService', () => {
  let service: ChatV2TaskRouterService;

  beforeEach(() => {
    service = new ChatV2TaskRouterService();
  });

  it('routes chat-history requests through the LLM result', async () => {
    jest
      .spyOn(service as any, 'routeWithLlm')
      .mockResolvedValue(
        JSON.stringify({
          domain: 'chat_history',
          confidence: 0.97,
          shipRelated: false,
          needsFreshExternalData: false,
          reason: 'The user asks about their previous message in this chat.',
          historyIntent: 'latest_user_message_before_current',
          webSearchQuery: null,
        }),
      );

    await expect(
      service.route({
        turnContext: {
          sessionId: 'session-1',
          userQuery: 'яке було моє останнє повідомлення',
          messageHistory: [],
          previousMessages: [],
        },
        classification: {
          kind: 'task_request',
          confidence: 0.9,
          language: 'uk',
          reason: 'task',
        },
      }),
    ).resolves.toMatchObject({
      domain: 'chat_history',
      historyIntent: 'latest_user_message_before_current',
    });
  });

  it('routes general web requests and preserves the search query', async () => {
    jest
      .spyOn(service as any, 'routeWithLlm')
      .mockResolvedValue(
        JSON.stringify({
          domain: 'general_web',
          confidence: 0.94,
          shipRelated: false,
          needsFreshExternalData: true,
          reason: 'The user asks for current weather information.',
          historyIntent: null,
          webSearchQuery: 'weather in Poland today',
        }),
      );

    await expect(
      service.route({
        turnContext: {
          sessionId: 'session-1',
          userQuery: 'Яка сьогодні погода в Польщі',
          messageHistory: [],
          previousMessages: [],
        },
        classification: {
          kind: 'task_request',
          confidence: 0.9,
          language: 'uk',
          reason: 'task',
        },
      }),
    ).resolves.toMatchObject({
      domain: 'general_web',
      webSearchQuery: 'weather in Poland today',
      needsFreshExternalData: true,
    });
  });

  it('routes ship-specific tasks through the LLM result', async () => {
    jest
      .spyOn(service as any, 'routeWithLlm')
      .mockResolvedValue(
        JSON.stringify({
          domain: 'ship_task',
          confidence: 0.99,
          shipRelated: true,
          needsFreshExternalData: false,
          reason: 'The user asks about current yacht speed.',
          historyIntent: null,
          webSearchQuery: null,
        }),
      );

    await expect(
      service.route({
        turnContext: {
          sessionId: 'session-1',
          userQuery: 'what is current yacht speed?',
          messageHistory: [],
          previousMessages: [],
        },
        classification: {
          kind: 'task_request',
          confidence: 0.9,
          language: 'en',
          reason: 'task',
        },
      }),
    ).resolves.toMatchObject({
      domain: 'ship_task',
      shipRelated: true,
    });
  });

  it('fails safe to unknown when LLM task routing is unavailable', async () => {
    jest
      .spyOn(service as any, 'routeWithLlm')
      .mockRejectedValue(new Error('LLM unavailable'));

    await expect(
      service.route({
        turnContext: {
          sessionId: 'session-1',
          userQuery: 'what is the weather in Poland?',
          messageHistory: [],
          previousMessages: [],
        },
        classification: {
          kind: 'task_request',
          confidence: 0.9,
          language: 'en',
          reason: 'task',
        },
      }),
    ).resolves.toMatchObject({
      domain: 'unknown',
      confidence: 0,
    });
  });
});
