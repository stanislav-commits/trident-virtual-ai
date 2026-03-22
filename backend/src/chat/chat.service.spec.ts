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

  it('answers direct aggregate telemetry tank queries deterministically without LLM arithmetic', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'calculate how many fuel onboard according to all fuel tanks',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'Volvo Penta operators manual',
          snippet: 'Fuel tank calibration procedure.',
          pageNumber: 163,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'calculate how many fuel onboard according to all fuel tanks',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Fuel Tank 1P': 3142,
        'Fuel Tank 2S': 2374,
        'Fuel Tank 3P': 434,
        'Fuel Tank 4S': 1047,
        'Fuel Tank 5P': 3164,
        'Fuel Tank 6S': 3163,
        'Fuel Tank 7P': 1002,
        'Fuel Tank 8S': 1055,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 8,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'calculate how many fuel onboard according to all fuel tanks',
      'Simens',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        'The total fuel onboard from the current matched telemetry readings is 15,381.',
      ),
      expect.objectContaining({
        resolvedSubjectQuery: 'calculate how many fuel onboard according to all fuel tanks',
        noDocumentation: true,
      }),
      [],
    );
  });

  it('answers onboard fuel totals deterministically for short aggregate phrasing', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'how many fuel onboard?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'how many fuel onboard?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Fuel Tank 1P': 3142,
        'Fuel Tank 2S': 2374,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 2,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'how many fuel onboard?',
      'Simens',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        'The total fuel onboard from the current matched telemetry readings is 5,516.',
      ),
      expect.objectContaining({
        resolvedSubjectQuery: 'how many fuel onboard?',
        noDocumentation: true,
      }),
      [],
    );
  });

  it('answers average calculations deterministically for coherent matched telemetry', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What is the average generator load?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'What is the average generator load?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Generator 1 Load — Unit: kW': 120,
        'Generator 2 Load — Unit: kW': 180,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 2,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What is the average generator load?',
      'Simens',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        'The average of the current matched telemetry readings is 150 kW.',
      ),
      expect.objectContaining({
        resolvedSubjectQuery: 'What is the average generator load?',
        noDocumentation: true,
      }),
      [],
    );
  });

  it('answers highest-value calculations deterministically for coherent matched telemetry', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'Which battery has the highest voltage?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'Which battery has the highest voltage?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Battery 1 Voltage — Unit: V': 24.1,
        'Battery 2 Voltage — Unit: V': 24.8,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 2,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'Which battery has the highest voltage?',
      'Simens',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        'The highest current matched telemetry reading is Battery 2 Voltage: 24.8 V.',
      ),
      expect.objectContaining({
        resolvedSubjectQuery: 'Which battery has the highest voltage?',
        noDocumentation: true,
      }),
      [],
    );
  });
});
