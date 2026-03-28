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
    resolveHistoricalTelemetryQuery: jest.fn(),
  } as any;

  const documentationService = {
    prepareDocumentationContext: jest.fn(),
  } as any;

  let service: ChatService;

  beforeEach(() => {
    jest.clearAllMocks();
    metricsService.resolveHistoricalTelemetryQuery.mockResolvedValue({
      kind: 'none',
    });
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

  it('returns historical telemetry clarification before current telemetry lookup', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What was the yacht position on 14 March?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'What was the yacht position on 14 March?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.resolveHistoricalTelemetryQuery.mockResolvedValue({
      kind: 'clarification',
      clarificationQuestion: 'Which year do you mean for 14 March?',
      pendingQuery: 'What was the yacht position on 14 March?',
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What was the yacht position on 14 March?',
      'SeaWolfX',
      'user',
    );

    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'Which year do you mean for 14 March?',
      expect.objectContaining({
        awaitingClarification: true,
        clarificationReason: 'historical_telemetry_query',
        pendingClarificationQuery: 'What was the yacht position on 14 March?',
      }),
      [],
    );
    expect(metricsService.getShipTelemetryContextForQuery).not.toHaveBeenCalled();
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('returns a historical telemetry answer before current telemetry lookup', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'How much fuel was used over the last 30 days?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'How much fuel was used over the last 30 days?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.resolveHistoricalTelemetryQuery.mockResolvedValue({
      kind: 'answer',
      content:
        'Based on historical telemetry from 2026-02-25 23:10 UTC to 2026-03-27 23:10 UTC, the total across the matched metrics was 4,384 liters [Telemetry History].',
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'How much fuel was used over the last 30 days?',
      'SeaWolfX',
      'user',
    );

    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'Based on historical telemetry from 2026-02-25 23:10 UTC to 2026-03-27 23:10 UTC, the total across the matched metrics was 4,384 liters [Telemetry History].',
      expect.objectContaining({
        historicalTelemetry: true,
      }),
      [],
    );
    expect(metricsService.getShipTelemetryContextForQuery).not.toHaveBeenCalled();
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('returns a historical telemetry answer for admin global chat sessions without a bound ship', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What was the average generator load over the last 7 days?',
          ragflowContext: null,
        },
      ],
    });
    prisma.ship.findMany.mockResolvedValue([
      {
        id: 'ship-1',
        name: 'SeaWolfX',
      },
    ]);
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'What was the average generator load over the last 7 days?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.resolveHistoricalTelemetryQuery.mockResolvedValue({
      kind: 'answer',
      content:
        'Based on historical telemetry from 2026-03-20 23:12 UTC to 2026-03-27 23:12 UTC, the average across the matched metrics was 4.52 % [Telemetry History].',
    });

    await (service as any).generateAssistantResponse(
      null,
      'session-1',
      'What was the average generator load over the last 7 days?',
      undefined,
      'admin',
    );

    expect(metricsService.resolveHistoricalTelemetryQuery).toHaveBeenCalledWith(
      'ship-1',
      'What was the average generator load over the last 7 days?',
      undefined,
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'Based on historical telemetry from 2026-03-20 23:12 UTC to 2026-03-27 23:12 UTC, the average across the matched metrics was 4.52 % [Telemetry History].',
      expect.objectContaining({
        historicalTelemetry: true,
        telemetryShips: ['SeaWolfX'],
      }),
      [],
    );
    expect(metricsService.getShipTelemetryContextForQuery).not.toHaveBeenCalled();
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('does not look up current telemetry for certificate-status questions', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'When does the fire suppression system certificate expire?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'Fire Suppression Survey.pdf',
          sourceCategory: 'CERTIFICATES',
          snippet: 'Certificate valid until 14 August 2026.',
          pageNumber: 1,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'When does the fire suppression system certificate expire?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    llmService.generateResponse.mockResolvedValue(
      'The fire suppression system certificate expires on 14 August 2026.',
    );

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'When does the fire suppression system certificate expire?',
      'Sea Wolf X',
      'user',
    );

    expect(metricsService.getShipTelemetryContextForQuery).not.toHaveBeenCalled();
    expect(llmService.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: {},
        telemetryPrefiltered: false,
        telemetryMatchMode: 'none',
      }),
    );
  });

  it('keeps forecast questions on the LLM path instead of returning telemetry clarification or current aggregates', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'How much fuel do we need to order for next month?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'M/Y Seawolf X - Components History.pdf',
          sourceCategory: 'HISTORY_PROCEDURES',
          snippet:
            'Generator fuel usage records are available for prior periods and should be compared with current onboard quantities.',
          pageNumber: 12,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'How much fuel do we need to order for next month?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Fuel Tank 1P': 3950,
        'Fuel Tank 2S': 3896,
        'SIEMENS-MASE-GENSET-SB.Total Fuel Used (l)': 35116,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 3,
      prefiltered: true,
      matchMode: 'related',
      clarification: {
        question:
          "I couldn't find a direct telemetry metric that exactly measures the requested reading, but I did find related metrics for the same topic. Which one do you want to inspect?",
        pendingQuery: 'What is the current value of',
        actions: [
          {
            label: 'Fuel Tank 1P',
            message: 'What is the current value of Fuel Tank 1P?',
            kind: 'suggestion',
          },
        ],
      },
    });
    llmService.generateResponse.mockResolvedValue(
      'Forecast answer using documentation and telemetry context.',
    );

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'How much fuel do we need to order for next month?',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: {
          'Fuel Tank 1P': 3950,
          'Fuel Tank 2S': 3896,
          'SIEMENS-MASE-GENSET-SB.Total Fuel Used (l)': 35116,
        },
        noDocumentation: false,
      }),
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'Forecast answer using documentation and telemetry context.',
      expect.anything(),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'M/Y Seawolf X - Components History.pdf',
        }),
      ]),
    );
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
        'The total fuel onboard from the current matched telemetry readings is 15,381',
      ),
      expect.objectContaining({
        resolvedSubjectQuery: 'calculate how many fuel onboard according to all fuel tanks',
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'Volvo Penta operators manual',
        }),
      ]),
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
        'The total fuel onboard from the current matched telemetry readings is 5,516',
      ),
      expect.objectContaining({
        resolvedSubjectQuery: 'how many fuel onboard?',
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
        'The average of the current matched telemetry readings is 150 kW',
      ),
      expect.objectContaining({
        resolvedSubjectQuery: 'What is the average generator load?',
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
        'The highest current matched telemetry reading is Battery 2 Voltage: 24.8 V',
      ),
      expect.objectContaining({
        resolvedSubjectQuery: 'Which battery has the highest voltage?',
      }),
      [],
    );
  });

  it('answers a single direct telemetry reading deterministically without calling the LLM', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What is the current fuel level?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'What is the current fuel level?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Tanks.Fuel_Level вЂ” Unit: %': 63,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 1,
      prefiltered: true,
      matchMode: 'exact',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What is the current fuel level?',
      'Simens',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'The current matched telemetry reading is Tanks.Fuel_Level: 63 % [Telemetry].',
      expect.objectContaining({
        resolvedSubjectQuery: 'What is the current fuel level?',
      }),
      [],
    );
  });

  it('answers multiple direct telemetry readings deterministically without calling the LLM', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What is the current water depth?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'What is the current water depth?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'environment.depth.belowKeel вЂ” Unit: m': 4.8,
        'environment.depth.belowSurface вЂ” Unit: m': 5.4,
        'environment.depth.belowTransducer вЂ” Unit: m': 6.1,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 3,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What is the current water depth?',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('The current matched telemetry readings are [Telemetry]:'),
      expect.objectContaining({
        resolvedSubjectQuery: 'What is the current water depth?',
      }),
      [],
    );

    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        '- environment.depth.belowKeel: 4.8 m',
      ),
      expect.anything(),
      [],
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        '- environment.depth.belowSurface: 5.4 m',
      ),
      expect.anything(),
      [],
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        '- environment.depth.belowTransducer: 6.1 m',
      ),
      expect.anything(),
      [],
    );
  });

  it('answers manual interval questions deterministically from cited manual evidence', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What is the oil change interval in the Volvo manual?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
          snippet:
            'Lubrication System. Engine oil must be changed every 500 hours. Oil change intervals must never exceed a period of 24 months.',
          pageNumber: 131,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'What is the oil change interval in the Volvo manual?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {},
      totalActiveMetrics: 0,
      matchedMetrics: 0,
      prefiltered: false,
      matchMode: 'none',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What is the oil change interval in the Volvo manual?',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'The documented interval is 500 hours [Manual: Volvo Penta_operators manual_47710211.pdf].',
      expect.objectContaining({
        resolvedSubjectQuery: 'What is the oil change interval in the Volvo manual?',
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
        }),
      ]),
    );
  });

  it.skip('answers manual range questions deterministically from cited manual evidence', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What is the normal coolant temperature range for this Volvo engine?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
          snippet:
            'Cooling system. The normal coolant temperature range is 75-95 °C during normal operation.',
          pageNumber: 140,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'What is the normal coolant temperature range for this Volvo engine?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'SIEMENS-MASE-GENSET-SB.Coolant Temperature (°C)': 36,
      },
      totalActiveMetrics: 1,
      matchedMetrics: 1,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What is the normal coolant temperature range for this Volvo engine?',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'The documented normal coolant temperature range is 75-95 °C [Manual: Volvo Penta_operators manual_47710211.pdf].',
      expect.objectContaining({
        resolvedSubjectQuery:
          'What is the normal coolant temperature range for this Volvo engine?',
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
        }),
      ]),
    );
  });

  it('answers manual range questions deterministically from cited manual evidence and prefers celsius', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What is the normal coolant temperature range for this Volvo engine?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'MMEN06 Manual SPC-II Hybrid - NG.pdf',
          snippet:
            'Electrical specifications: Nominal Input Voltage 230/400V 3ph. Input Voltage range 170-520V 3ph.',
          pageNumber: 68,
        },
        {
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
          snippet:
            'The instrument shows engine coolant temperature. During operations, coolant temperature should normally be between 75 and 95°C (167-203°F).',
          pageNumber: 38,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'What is the normal coolant temperature range for this Volvo engine?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'SIEMENS-MASE-GENSET-SB.Coolant Temperature (°C)': 36,
      },
      totalActiveMetrics: 1,
      matchedMetrics: 1,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What is the normal coolant temperature range for this Volvo engine?',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'The documented normal coolant temperature range is 75-95 °C [Manual: Volvo Penta_operators manual_47710211.pdf].',
      expect.objectContaining({
        resolvedSubjectQuery:
          'What is the normal coolant temperature range for this Volvo engine?',
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
        }),
      ]),
    );
  });

  it('returns a deterministic unavailable message when a current telemetry value is not directly matched', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What is the current starboard engine coolant temperature?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'MMEN06 Manual SPC-II Hybrid - NG.pdf',
          snippet:
            'Electrical specifications: Nominal Input Voltage 230/400V 3ph. Input Voltage range 170-520V 3ph.',
          pageNumber: 68,
        },
        {
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
          snippet:
            'The instrument shows engine coolant temperature. During operations, coolant temperature should normally be between 75 and 95°C (167-203°F).',
          pageNumber: 38,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'What is the current starboard engine coolant temperature?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {},
      totalActiveMetrics: 0,
      matchedMetrics: 0,
      prefiltered: false,
      matchMode: 'none',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What is the current starboard engine coolant temperature?',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      "I couldn't confirm the current starboard engine coolant temperature from a direct matched telemetry reading. The available manual evidence only confirms the documented normal coolant temperature range of 75-95 °C [Manual: Volvo Penta_operators manual_47710211.pdf], not the current live reading.",
      expect.objectContaining({
        resolvedSubjectQuery:
          'What is the current starboard engine coolant temperature?',
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
        }),
      ]),
    );
  });

  it('does not forward telemetry context to the LLM for maintenance procedure questions', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'How do I check and clean the seawater filter?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
          snippet:
            'Close the sea cock. Remove the lid (1) and lift up the insert. Clean the insert. Fit the insert and open the sea cock before starting the engine. Check that there are no leaks.',
          pageNumber: 140,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'How do I check and clean the seawater filter?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'SIEMENS-MASE-GENSET-PS.Seawater pressure (bar)': 0,
        'SIEMENS-MASE-GENSET-SB.Seawater pressure (bar)': 0,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 2,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });
    llmService.generateResponse.mockResolvedValue('Documented procedure answer.');

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'How do I check and clean the seawater filter?',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        userQuery: 'How do I check and clean the seawater filter?',
        telemetry: {},
        telemetryPrefiltered: false,
        telemetryMatchMode: 'none',
      }),
    );
  });

  it('does not forward unrelated telemetry context to the LLM for alarm-list troubleshooting lookups', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content:
            'What does the generator alarm list say about low oil pressure or high coolant temperature?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
          snippet:
            'Low Oil Pressure and Coolant Temperature alarms are shown in the alarm list. Refer to fault handling and the fault code register for corrective actions.',
          pageNumber: 110,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery:
        'What does the generator alarm list say about low oil pressure or high coolant temperature?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'SIEMENS-MASE-GENSET-PS.Coolant Temperature (°C)': 31,
        'SIEMENS-MASE-GENSET-SB.Coolant Temperature (°C)': 36,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 2,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });
    llmService.generateResponse.mockResolvedValue('Documented troubleshooting answer.');

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What does the generator alarm list say about low oil pressure or high coolant temperature?',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: {},
        telemetryPrefiltered: false,
        telemetryMatchMode: 'none',
      }),
    );
  });

  it('keeps guidance-style telemetry questions on the LLM path', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'Based on the current oil level, what should I do next?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'Volvo Penta operators manual',
          snippet:
            'Pull out the dipstick and ensure the oil level is between MAX and MIN markings.',
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'Based on the current oil level, what should I do next?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'CleanOilTank.Level вЂ” Unit: l': 9,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 1,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });
    llmService.generateResponse.mockResolvedValue(
      'Check the documented dipstick range before taking action.',
    );

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'Based on the current oil level, what should I do next?',
      'Simens',
      'user',
    );

    expect(llmService.generateResponse).toHaveBeenCalledTimes(1);
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'Check the documented dipstick range before taking action.',
      expect.objectContaining({
        resolvedSubjectQuery: 'Based on the current oil level, what should I do next?',
      }),
      expect.any(Array),
    );
  });
});
