import { ChatService } from './chat.service';

describe('ChatService telemetry clarification', () => {
  const prisma = {
    chatSession: {
      findUnique: jest.fn(),
    },
    ship: {
      findMany: jest.fn(),
    },
  } as any;

  const llmService = {
    generateResponse: jest.fn(),
  } as any;

  const metricsService = {
    getShipTelemetryContextForQuery: jest.fn(),
  } as any;

  const documentationService = {
    prepareDocumentationContext: jest.fn(),
  } as any;

  let service: ChatService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ChatService(
      prisma,
      llmService,
      metricsService,
      documentationService,
    );
    jest.spyOn(service, 'addAssistantMessage').mockResolvedValue({
      id: 'assistant-1',
    } as any);
  });

  it('returns related telemetry clarification for admin global chat sessions', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What is the current fuel level?',
          ragflowContext: null,
        },
      ],
    });
    prisma.ship.findMany.mockResolvedValue([
      {
        id: 'ship-1',
        name: 'Simens',
      },
    ]);
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'What is the current fuel level?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'SIEMENS-MASE-GENSET-PS.Diesel Fuel Rate (l/h)': 61.4,
      },
      totalActiveMetrics: 12,
      matchedMetrics: 4,
      prefiltered: true,
      matchMode: 'related',
      clarification: {
        question:
          "I couldn't find a direct telemetry metric that exactly measures the requested reading, but I did find related metrics for the same topic. Which one do you want to inspect?",
        pendingQuery: 'What is the current value of',
        actions: [
          {
            label: 'SIEMENS-MASE-GENSET-PS.Diesel Fuel Rate (l/h)',
            message:
              'What is the current value of SIEMENS-MASE-GENSET-PS.Diesel Fuel Rate (l/h)?',
            kind: 'suggestion',
          },
        ],
      },
    });

    await (service as any).generateAssistantResponse(
      null,
      'session-1',
      'What is the current fuel level?',
      undefined,
      'admin',
    );

    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      "I couldn't find a direct telemetry metric that exactly measures the requested reading, but I did find related metrics for the same topic. Which one do you want to inspect?",
      expect.objectContaining({
        awaitingClarification: true,
        clarificationReason: 'related_telemetry_options',
        telemetryShips: ['Simens'],
        clarificationActions: [
          expect.objectContaining({
            label: 'Simens: SIEMENS-MASE-GENSET-PS.Diesel Fuel Rate (l/h)',
            message:
              'For Simens, What is the current value of SIEMENS-MASE-GENSET-PS.Diesel Fuel Rate (l/h)?',
          }),
        ],
      }),
      [],
    );
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });
});
