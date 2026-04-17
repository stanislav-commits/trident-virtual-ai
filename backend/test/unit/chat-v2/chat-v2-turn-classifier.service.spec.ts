import { ChatV2TurnClassifierService } from '../../../src/chat-v2/intake/chat-v2-turn-classifier.service';

describe('ChatV2TurnClassifierService', () => {
  let classifier: ChatV2TurnClassifierService;

  beforeEach(() => {
    classifier = new ChatV2TurnClassifierService();
  });

  it('uses the LLM classification result for pure greetings', async () => {
    jest
      .spyOn(classifier as any, 'classifyWithLlm')
      .mockResolvedValue(
        JSON.stringify({
          kind: 'small_talk',
          confidence: 0.98,
          language: 'en',
          reason: 'The user is greeting the assistant.',
          userTask: null,
        }),
      );

    await expect(classifier.classify('hi there')).resolves.toMatchObject({
      kind: 'small_talk',
      confidence: 0.98,
    });
  });

  it('lets the LLM keep social questions as small talk', async () => {
    jest
      .spyOn(classifier as any, 'classifyWithLlm')
      .mockResolvedValue(
        JSON.stringify({
          kind: 'small_talk',
          confidence: 0.97,
          language: 'en',
          reason: 'The user is asking a social check-in question.',
          userTask: null,
        }),
      );

    await expect(
      classifier.classify('How are you doing today?'),
    ).resolves.toMatchObject({
      kind: 'small_talk',
    });
  });

  it('lets the LLM route greetings with real requests as task requests', async () => {
    jest
      .spyOn(classifier as any, 'classifyWithLlm')
      .mockResolvedValue(
        JSON.stringify({
          kind: 'task_request',
          confidence: 0.99,
          language: 'en',
          reason: 'The user asks for current vessel telemetry.',
          userTask: 'current yacht speed',
        }),
      );

    await expect(
      classifier.classify('hi, what is current yacht speed?'),
    ).resolves.toMatchObject({
      kind: 'task_request',
      userTask: 'current yacht speed',
    });
  });

  it('lets the LLM route chat-history questions as task requests', async () => {
    jest
      .spyOn(classifier as any, 'classifyWithLlm')
      .mockResolvedValue(
        JSON.stringify({
          kind: 'task_request',
          confidence: 0.95,
          language: 'en',
          reason: 'The user asks to recall chat history.',
          userTask: 'previous question in this chat',
        }),
      );

    await expect(
      classifier.classify('what was my previous question?'),
    ).resolves.toMatchObject({
      kind: 'task_request',
    });
  });

  it('fails safe to task_request when LLM classification is unavailable', async () => {
    jest
      .spyOn(classifier as any, 'classifyWithLlm')
      .mockRejectedValue(new Error('LLM unavailable'));

    await expect(classifier.classify('How are you doing today?')).resolves.toMatchObject(
      {
        kind: 'task_request',
        confidence: 0,
      },
    );
  });
});
