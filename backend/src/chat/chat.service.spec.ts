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
        answerRoute: 'clarification',
        clarificationReason: 'related_telemetry_options',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
        usedHistoricalTelemetry: false,
        telemetryShips: ['Simens'],
        normalizedQuery: expect.objectContaining({
          sourceHints: expect.arrayContaining(['TELEMETRY']),
        }),
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
        answerRoute: 'clarification',
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
        answerRoute: 'historical_telemetry',
        historicalTelemetry: true,
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: false,
        usedHistoricalTelemetry: true,
        normalizedQuery: expect.objectContaining({
          timeIntent: expect.objectContaining({
            kind: 'historical_range',
          }),
        }),
      }),
      [],
    );
    expect(metricsService.getShipTelemetryContextForQuery).not.toHaveBeenCalled();
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('does not silently fall back to current telemetry for unresolved historical telemetry intent', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'what was fuel onboard yesterday?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'what was fuel onboard yesterday?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.resolveHistoricalTelemetryQuery.mockResolvedValue({
      kind: 'none',
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'what was fuel onboard yesterday?',
      'SeaWolfX',
      'user',
    );

    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        'I am not substituting current values as a fallback',
      ),
      expect.objectContaining({
        awaitingClarification: true,
        answerRoute: 'clarification',
        clarificationReason: 'historical_current_fallback_blocked',
        currentTelemetryFallbackAllowed: false,
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
      expect.objectContaining({
        sourceHints: expect.arrayContaining(['TELEMETRY', 'HISTORY']),
      }),
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'Based on historical telemetry from 2026-03-20 23:12 UTC to 2026-03-27 23:12 UTC, the average across the matched metrics was 4.52 % [Telemetry History].',
      expect.objectContaining({
        answerRoute: 'historical_telemetry',
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

  it('keeps high-confidence procedural documentation queries out of current inventory telemetry', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What should I do before taking fuel onboard?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'Fuel transfer procedure.pdf',
          sourceCategory: 'REGULATION',
          snippet:
            'Before receiving fuel onboard, prepare the transfer checklist and monitor the operation.',
          pageNumber: 2,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'What should I do before taking fuel onboard?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
      semanticQuery: {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'operational_procedure',
        conceptFamily: 'operational_topic',
        selectedConceptIds: ['bunkering_operation'],
        candidateConceptIds: ['bunkering_operation'],
        equipment: [],
        systems: ['fuel_system'],
        vendor: null,
        model: null,
        sourcePreferences: ['HISTORY_PROCEDURES', 'REGULATION'],
        explicitSource: null,
        pageHint: null,
        sectionHint: null,
        answerFormat: 'checklist',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.92,
      },
    });
    llmService.generateResponse.mockResolvedValue(
      'Use the documented fuel transfer checklist before receiving fuel onboard.',
    );

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What should I do before taking fuel onboard?',
      'Sea Wolf X',
      'user',
    );

    expect(metricsService.getShipTelemetryContextForQuery).not.toHaveBeenCalled();
    expect(llmService.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        telemetry: {},
        telemetryPrefiltered: false,
        telemetryMatchMode: 'none',
        noDocumentation: false,
      }),
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'Use the documented fuel transfer checklist before receiving fuel onboard.',
      expect.objectContaining({
        answerRoute: 'llm_generation',
        usedDocumentation: true,
        usedCurrentTelemetry: false,
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'Fuel transfer procedure.pdf',
        }),
      ]),
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

  it('builds a deterministic fuel forecast from historical fuel use and current tank telemetry', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'calculate how many fuel do i need for the next month?',
          ragflowContext: null,
        },
      ],
    });
    prisma.ship.findMany.mockResolvedValue([
      {
        id: 'ship-1',
        name: 'Sea Wolf X',
      },
    ]);
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
          sourceCategory: 'HISTORY_PROCEDURES',
          snippet: 'Annual service row for main generator maintenance.',
          pageNumber: 10,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'calculate how many fuel do i need for the next month?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.resolveHistoricalTelemetryQuery.mockImplementation(
      async (_shipId: string, query: string) => {
        if (query === 'How much fuel was used over the last 30 days?') {
          return {
            kind: 'answer',
            content:
              'Based on historical telemetry from 2026-02-25 23:46 UTC to 2026-03-27 23:46 UTC, the total across the matched metrics was 4,384 liters [Telemetry History].',
          };
        }

        return { kind: 'none' };
      },
    );
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Fuel Tank 1P': 3950,
        'Fuel Tank 2S': 3896,
        'Fuel Tank 3P': 462,
        'Fuel Tank 4S': 370,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 4,
      prefiltered: true,
      matchMode: 'related',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      null,
      'session-1',
      'calculate how many fuel do i need for the next month?',
      undefined,
      'admin',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        'projected fuel consumption for the next month is approximately 4,384 liters',
      ),
      expect.objectContaining({
        noDocumentation: true,
      }),
      [],
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        'Current onboard fuel across the matched tank readings is 8,678 liters',
      ),
      expect.anything(),
      [],
    );
  });

  it('answers tank capacity table questions deterministically from structured tank rows', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'show tank capacities for fuel tanks',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'Fuel Tank Sounding Table.pdf',
          pageNumber: 3,
          snippet:
            'Fuel Tank 1P capacity 3,142 liters Fuel Tank 2S capacity 2,381 liters',
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'show tank capacities for fuel tanks',
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
      'show tank capacities for fuel tanks',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('Fuel Tank 1P: 3,142 liters'),
      expect.objectContaining({
        answerRoute: 'deterministic_document',
        usedLlm: false,
        usedDocumentation: true,
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'Fuel Tank Sounding Table.pdf',
        }),
      ]),
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('Fuel Tank 2S: 2,381 liters'),
      expect.anything(),
      expect.anything(),
    );
  });

  it('answers tank capacity table questions from SOPEP-style HTML tables with shared capacity headers', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'show tank capacities for fuel tanks',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'Seawolf X SOPEP.pdf',
          pageNumber: 10,
          snippet:
            "SHIPBOARD OIL POLLUTION EMERGENCY PLAN List Of Tank Capacities <table><caption> FUELOILTANKS</caption> <tr><td >TANK No</td><td >DESCRIPTION</td><td >IMP. GAL.</td><td >CAPACITY (It)</td><td >FRAME</td></tr> <tr><td >FO1.PS</td><td >Midship/Aft Port Fuel Tank</td><td></td><td >4970</td><td >12-15</td></tr> <tr><td >FO2.STBD</td><td >Midship/Aft Starboard Fuel Tank</td><td></td><td >4970</td><td >12-15</td></tr></table>",
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'show tank capacities for fuel tanks',
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
      'show tank capacities for fuel tanks',
      'Sea Wolf X',
      'user',
    );

    const content = (service.addAssistantMessage as jest.Mock).mock.calls.at(-1)?.[1];
    const contextRefs = (service.addAssistantMessage as jest.Mock).mock.calls.at(-1)?.[3];
    expect(content).toContain('FO1.PS - Midship/Aft Port Fuel Tank: 4970 liters');
    expect(content).toContain(
      'FO2.STBD - Midship/Aft Starboard Fuel Tank: 4970 liters',
    );
    expect(content).toContain('Seawolf X SOPEP.pdf');
    expect(contextRefs).toEqual([
      expect.objectContaining({
        sourceTitle: 'Seawolf X SOPEP.pdf',
      }),
    ]);
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('answers broad certificate expiry questions deterministically from explicit certificate dates', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 2, 28));
    try {
      prisma.chatSession.findUnique.mockResolvedValue({
        messages: [
          {
            role: 'user',
            content: 'Which certificates will expire soon?',
            ragflowContext: null,
          },
        ],
      });
      documentationService.prepareDocumentationContext.mockResolvedValue({
        citations: [
          {
            sourceTitle:
              '26.01.13 SEAWOLF X Renewal Certificate of Reg. (exp 27.01.15).pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'CERTIFICATE OF MALTA REGISTRY. Renewing Certificate dated 06 January 2025.',
            pageNumber: 1,
          },
          {
            sourceTitle: 'Fire Suppression Survey.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'Fixed fire suppression system survey. Certificate valid until 14 August 2026.',
            pageNumber: 1,
          },
          {
            sourceTitle:
              'VSS001980 - VSS Fire Extinguisher Powder Kg 6_SOLAS Certificato Mod. B.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet: 'Expiry 07/01/2026.',
            pageNumber: 1,
          },
        ],
        previousUserQuery: undefined,
        retrievalQuery: 'Which certificates will expire soon?',
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
        'Which certificates will expire soon?',
        'Sea Wolf X',
        'user',
      );

      expect(llmService.generateResponse).not.toHaveBeenCalled();
      expect(service.addAssistantMessage).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('14 August 2026'),
        expect.anything(),
        [
          expect.objectContaining({
            sourceTitle: 'Fire Suppression Survey.pdf',
          }),
        ],
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('answers broad certification expiry wording deterministically from explicit certificate dates', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 2, 28));
    try {
      prisma.chatSession.findUnique.mockResolvedValue({
        messages: [
          {
            role: 'user',
            content: 'Which certifications will expire soon?',
            ragflowContext: null,
          },
        ],
      });
      documentationService.prepareDocumentationContext.mockResolvedValue({
        citations: [
          {
            sourceTitle: 'Fire Suppression Survey.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'Fixed fire suppression system survey. Certificate valid until 14 August 2026.',
            pageNumber: 1,
          },
        ],
        previousUserQuery: undefined,
        retrievalQuery: 'Which certifications will expire soon?',
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
        'Which certifications will expire soon?',
        'Sea Wolf X',
        'user',
      );

      expect(llmService.generateResponse).not.toHaveBeenCalled();
      expect(service.addAssistantMessage).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('14 August 2026'),
        expect.objectContaining({
          answerRoute: 'deterministic_certificate',
          usedLlm: false,
        }),
        [expect.objectContaining({ sourceTitle: 'Fire Suppression Survey.pdf' })],
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('answers broad certificate expiry questions from hyphenated month expiry dates', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 2, 28));
    try {
      prisma.chatSession.findUnique.mockResolvedValue({
        messages: [
          {
            role: 'user',
            content: 'Which certificates will expire soon?',
            ragflowContext: null,
          },
        ],
      });
      documentationService.prepareDocumentationContext.mockResolvedValue({
        citations: [
          {
            sourceTitle: 'CoR Private.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'CERTIFICATE OF MALTA REGISTRY. Official and IMO No. Name of Ship SEAWOLF X.',
            pageNumber: 1,
          },
          {
            sourceTitle: 'Selmar Type Approval Certificate.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'THIS CERTIFICATE IS ISSUED IN COMPLIANCE WITH MODULE D. ISSUE DATE: 10-feb-2022 EXPIRATION DATE: 22-dec-2026.',
            pageNumber: 161,
          },
        ],
        previousUserQuery: undefined,
        retrievalQuery: 'Which certificates will expire soon?',
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
        'Which certificates will expire soon?',
        'Sea Wolf X',
        'user',
      );

      expect(llmService.generateResponse).not.toHaveBeenCalled();
      expect(service.addAssistantMessage).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('22 December 2026'),
        expect.anything(),
        [
          expect.objectContaining({
            sourceTitle: 'Selmar Type Approval Certificate.pdf',
          }),
        ],
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('prefers the nearest future expiry when one certificate snippet contains multiple dates', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2024, 2, 28));
    try {
      prisma.chatSession.findUnique.mockResolvedValue({
        messages: [
          {
            role: 'user',
            content: 'Which certificates will expire soon?',
            ragflowContext: null,
          },
        ],
      });
      documentationService.prepareDocumentationContext.mockResolvedValue({
        citations: [
          {
            sourceTitle: 'Selmar Type Approval Certificate.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'THIS CERTIFICATE IS ISSUED IN COMPLIANCE WITH MODULE D. ISSUE DATE: 10-feb-2022 EXPIRATION DATE: 22-dec-2026. Product Design Assessment (PDA) Expiry Date 27-OCT-2025. Manufacturing Assessment (MA) Expiry Date 28-OCT-2025.',
            pageNumber: 161,
          },
        ],
        previousUserQuery: undefined,
        retrievalQuery: 'Which certificates will expire soon?',
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
        'Which certificates will expire soon?',
        'Sea Wolf X',
        'user',
      );

      expect(llmService.generateResponse).not.toHaveBeenCalled();
      expect(service.addAssistantMessage).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('27 October 2025'),
        expect.anything(),
        [
          expect.objectContaining({
            sourceTitle: 'Selmar Type Approval Certificate.pdf',
          }),
        ],
      );
      expect(service.addAssistantMessage).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('1 year and 7 months'),
        expect.anything(),
        expect.any(Array),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('deduplicates registry-style certificate expiries in broad upcoming answers', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 2, 28));
    try {
      prisma.chatSession.findUnique.mockResolvedValue({
        messages: [
          {
            role: 'user',
            content: 'Which certificates will expire soon?',
            ragflowContext: null,
          },
        ],
      });
      documentationService.prepareDocumentationContext.mockResolvedValue({
        citations: [
          {
            sourceTitle:
              '26.01.13 SEAWOLF X Renewal Certificate of Reg. (exp 27.01.15).pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'CERTIFICATE OF MALTA REGISTRY. Renewing Certificate dated 06 January 2025. This certificate expires on 15 January 2027.',
            pageNumber: 1,
          },
          {
            sourceTitle: '040326 COR Commercial use SEAWOLF X.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'CERTIFICATE OF MALTA REGISTRY. Official and IMO No. Name of Ship SEAWOLF X. This certificate expires on 15 January 2027.',
            pageNumber: 1,
          },
          {
            sourceTitle: 'Fire Equipment Type Approval.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'Product Design Assessment. Expiry Date 22-DEC-2027.',
            pageNumber: 12,
          },
        ],
        previousUserQuery: undefined,
        retrievalQuery: 'Which certificates will expire soon?',
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
        'Which certificates will expire soon?',
        'Sea Wolf X',
        'user',
      );

      expect(llmService.generateResponse).not.toHaveBeenCalled();
      const assistantCall = (service.addAssistantMessage as jest.Mock).mock.calls.at(-1);
      expect(assistantCall?.[1]).toContain(
        'The nearest upcoming certificate expiries I found are:',
      );
      expect(assistantCall?.[1]).not.toContain(
        'within the next 180 days',
      );
      expect((assistantCall?.[1].match(/15 January 2027/g) ?? []).length).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('answers plural expiry phrasing deterministically for broad certificate queries', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 2, 28));
    try {
      prisma.chatSession.findUnique.mockResolvedValue({
        messages: [
          {
            role: 'user',
            content: 'Show me the nearest upcoming certificate expiries',
            ragflowContext: null,
          },
        ],
      });
      documentationService.prepareDocumentationContext.mockResolvedValue({
        citations: [
          {
            sourceTitle: 'Selmar Type Approval Certificate.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'THIS CERTIFICATE IS ISSUED IN COMPLIANCE WITH MODULE D. EXPIRATION DATE: 22-dec-2026.',
            pageNumber: 161,
          },
        ],
        previousUserQuery: undefined,
        retrievalQuery: 'Show me the nearest upcoming certificate expiries',
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
        'Show me the nearest upcoming certificate expiries',
        'Sea Wolf X',
        'user',
      );

      expect(llmService.generateResponse).not.toHaveBeenCalled();
      expect(service.addAssistantMessage).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('22 December 2026'),
        expect.anything(),
        [
          expect.objectContaining({
            sourceTitle: 'Selmar Type Approval Certificate.pdf',
          }),
        ],
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses broader certificate analysis citations when answer citations lost expiry evidence', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 2, 28));
    try {
      prisma.chatSession.findUnique.mockResolvedValue({
        messages: [
          {
            role: 'user',
            content: 'Show me the nearest upcoming certificate expiries',
            ragflowContext: null,
          },
        ],
      });
      documentationService.prepareDocumentationContext.mockResolvedValue({
        citations: [
          {
            sourceTitle: 'FA170_OME44900J.pdf',
            sourceCategory: 'MANUALS',
            snippet:
              'bearing to a target are updated. However, target order is not updated.',
            pageNumber: 29,
          },
        ],
        analysisCitations: [
          {
            sourceTitle: 'FA170_OME44900J.pdf',
            sourceCategory: 'MANUALS',
            snippet:
              'bearing to a target are updated. However, target order is not updated.',
            pageNumber: 29,
          },
          {
            sourceTitle: '26.03.04 Renewal Radio Licence COMMERCIAL.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'This Licence expires on: 15 January 2027.',
            pageNumber: 1,
          },
        ],
        previousUserQuery: undefined,
        retrievalQuery: 'Show me the nearest upcoming certificate expiries',
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
        'Show me the nearest upcoming certificate expiries',
        'Sea Wolf X',
        'user',
      );

      expect(llmService.generateResponse).not.toHaveBeenCalled();
      expect(service.addAssistantMessage).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('15 January 2027'),
        expect.anything(),
        [
          expect.objectContaining({
            sourceTitle: '26.03.04 Renewal Radio Licence COMMERCIAL.pdf',
          }),
        ],
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('uses embedded approval expiry evidence when broad certificate snippets come from a manual appendix', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2024, 2, 28));
    try {
      prisma.chatSession.findUnique.mockResolvedValue({
        messages: [
          {
            role: 'user',
            content: 'Which certificates will expire soon?',
            ragflowContext: null,
          },
        ],
      });
      documentationService.prepareDocumentationContext.mockResolvedValue({
        citations: [
          {
            sourceTitle:
              "Selmar_2023F29001_Blue Sea 4000 Plus_User's Guide.pdf",
            sourceCategory: 'MANUALS',
            snippet:
              'Product Design Assessment (PDA) Expiry Date 27-OCT-2025. Manufacturing Assessment (MA) Expiry Date 28-OCT-2025.',
            pageNumber: 161,
          },
        ],
        previousUserQuery: undefined,
        retrievalQuery: 'Which certificates will expire soon?',
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
        'Which certificates will expire soon?',
        'Sea Wolf X',
        'user',
      );

      expect(llmService.generateResponse).not.toHaveBeenCalled();
      expect(service.addAssistantMessage).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('27 October 2025'),
        expect.anything(),
        [
          expect.objectContaining({
            sourceTitle:
              "Selmar_2023F29001_Blue Sea 4000 Plus_User's Guide.pdf",
          }),
        ],
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('prefers standalone certificate expiries over embedded manual approvals when both are available', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 2, 31));
    try {
      prisma.chatSession.findUnique.mockResolvedValue({
        messages: [
          {
            role: 'user',
            content: 'Which certifications will expire soon?',
            ragflowContext: null,
          },
        ],
      });
      documentationService.prepareDocumentationContext.mockResolvedValue({
        citations: [
          {
            sourceTitle:
              "Selmar_2023F29001_Blue Sea 4000 Plus_User's Guide.pdf",
            sourceCategory: 'CERTIFICATES',
            snippet:
              'Product Design Assessment (PDA) Expiry Date 22-DEC-2026. Manufacturing Assessment (MA) Expiry Date 28-OCT-2027.',
            pageNumber: 161,
          },
          {
            sourceTitle: '26.03.04 Renewal Radio Licence COMMERCIAL.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'Radio station communication license. Certificate valid until 15 January 2027.',
            pageNumber: 1,
          },
        ],
        previousUserQuery: undefined,
        retrievalQuery: 'Which certifications will expire soon?',
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
        'Which certifications will expire soon?',
        'Sea Wolf X',
        'user',
      );

      const content = (service.addAssistantMessage as jest.Mock).mock.calls.at(-1)?.[1];
      const contextRefs = (service.addAssistantMessage as jest.Mock).mock.calls.at(-1)?.[3];

      expect(content).toContain('15 January 2027');
      expect(content).not.toContain("Selmar_2023F29001_Blue Sea 4000 Plus_User's Guide.pdf");
      expect(contextRefs).toEqual([
        expect.objectContaining({
          sourceTitle: '26.03.04 Renewal Radio Licence COMMERCIAL.pdf',
        }),
      ]);
      expect(llmService.generateResponse).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not let broad certificate expiry questions fall back to LLM when snippets lack explicit expiry dates', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 2, 28));
    try {
      prisma.chatSession.findUnique.mockResolvedValue({
        messages: [
          {
            role: 'user',
            content: 'Which certificates will expire soon?',
            ragflowContext: null,
          },
        ],
      });
      documentationService.prepareDocumentationContext.mockResolvedValue({
        citations: [
          {
            sourceTitle: 'CoR Private.pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'CERTIFICATE OF MALTA REGISTRY. Official and IMO No. Name of Ship SEAWOLF X.',
            pageNumber: 1,
          },
          {
            sourceTitle:
              '26.01.13 SEAWOLF X Renewal Certificate of Reg. (exp 27.01.15).pdf',
            sourceCategory: 'CERTIFICATES',
            snippet:
              'CERTIFICATE OF MALTA REGISTRY. Renewing Certificate dated 06 January 2025.',
            pageNumber: 1,
          },
        ],
        previousUserQuery: undefined,
        retrievalQuery: 'Which certificates will expire soon?',
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
        'Which certificates will expire soon?',
        'Sea Wolf X',
        'user',
      );

      expect(llmService.generateResponse).not.toHaveBeenCalled();
      expect(service.addAssistantMessage).toHaveBeenCalledWith(
        'session-1',
        expect.stringContaining('do not include clear expiry dates'),
        expect.anything(),
        expect.arrayContaining([
          expect.objectContaining({
            sourceTitle: 'CoR Private.pdf',
          }),
        ]),
      );
    } finally {
      nowSpy.mockRestore();
    }
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
        answerRoute: 'current_telemetry',
        usedDocumentation: false,
        usedCurrentTelemetry: true,
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
        answerRoute: 'current_telemetry',
        resolvedSubjectQuery: 'What is the current fuel level?',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
        usedHistoricalTelemetry: false,
      }),
      [],
    );
  });

  it('answers current vessel location questions from telemetry without falling back to documentation', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'Where is the yacht now?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'Where is the yacht now?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'navigation.position.lat': 43.55,
        'navigation.position.lon': 7.02,
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
      'Where is the yacht now?',
      'Sea Wolf X',
      'user',
    );

    expect(metricsService.getShipTelemetryContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      'Where is the yacht now?',
      undefined,
    );
    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('navigation.position.lat'),
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
      }),
      [],
    );
  });

  it('answers admin global current location questions through telemetry lookup', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'what lon and lat is now?',
          ragflowContext: null,
        },
      ],
    });
    prisma.ship.findMany.mockResolvedValue([
      {
        id: 'ship-1',
        name: 'Sea Wolf X',
      },
    ]);
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'what lon and lat is now?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'navigation.position.lat': 43.55,
        'navigation.position.lon': 7.02,
      },
      totalActiveMetrics: 20,
      matchedMetrics: 2,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      null,
      'session-1',
      'what lon and lat is now?',
      undefined,
      'admin',
    );

    expect(prisma.ship.findMany).toHaveBeenCalled();
    expect(metricsService.getShipTelemetryContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      'what lon and lat is now?',
      undefined,
    );
    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('[Sea Wolf X] navigation.position.lat'),
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
      }),
      [],
    );
  });

  it('answers full telemetry inventory alarm queries deterministically without falling back to documentation', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'List all available bilge alarm metrics',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'bilgmon488_instruction_manual_vAE - 2020.pdf',
          snippet: 'The bilge alarm has 2 adjustable alarms.',
        },
      ],
      previousUserQuery: undefined,
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Bilge-Alarms.BILGE ALARM 1': 0,
        'Bilge-Alarms.BILGE ALARM 2': 0,
        'Bilge-Alarms.BILGE ALARM 3': 0,
      },
      totalActiveMetrics: 24,
      matchedMetrics: 3,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'List all available bilge alarm metrics',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('The matched telemetry metrics are [Telemetry]:'),
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
      }),
      [],
    );
  });

  it('answers live alarm-state queries from current telemetry instead of drifting into documentation', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'Are any bilge alarms active right now?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'Are any bilge alarms active right now?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Bilge-Alarms.BILGE ALARM 1': 0,
        'Bilge-Alarms.BILGE ALARM 2': 0,
      },
      totalActiveMetrics: 24,
      matchedMetrics: 2,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'Are any bilge alarms active right now?',
      'Sea Wolf X',
      'user',
    );

    expect(metricsService.getShipTelemetryContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      'Are any bilge alarms active right now?',
      undefined,
    );
    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('The current matched telemetry readings are [Telemetry]:'),
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
      }),
      [],
    );
  });

  it('answers plural current-reading queries from telemetry when live metrics exist', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What are the port generator battery charger voltages right now?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery:
        'What are the port generator battery charger voltages right now?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'PORT-GENERATOR-BATTERY-CHARGER.RMS phase to neutral Voltage A-N': 228.1,
        'PORT-GENERATOR-BATTERY-CHARGER.RMS phase to neutral Voltage B-N': 0,
        'PORT-GENERATOR-BATTERY-CHARGER.RMS phase to neutral Voltage C-N': 0,
      },
      totalActiveMetrics: 47,
      matchedMetrics: 3,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What are the port generator battery charger voltages right now?',
      'Sea Wolf X',
      'user',
    );

    expect(metricsService.getShipTelemetryContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      'What are the port generator battery charger voltages right now?',
      undefined,
    );
    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('The current matched telemetry readings are [Telemetry]:'),
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
      }),
      [],
    );
  });

  it('answers generic telemetry inventory queries with the full list by default', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'List of bilge alarm metrics',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Bilge-Alarms.BILGE ALARM 1': 0,
        'Bilge-Alarms.BILGE ALARM 2': 0,
        'Bilge-Alarms.BILGE ALARM 3': 0,
        'Bilge-Alarms.BILGE ALARM 4': 0,
      },
      totalActiveMetrics: 24,
      matchedMetrics: 4,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'List of bilge alarm metrics',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('The matched telemetry metrics are [Telemetry]:'),
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
      }),
      [],
    );
  });

  it('answers sampled telemetry inventory queries deterministically and says that the response is sampled', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'Show 10 random active metrics for this ship.',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `Misc.Signal_${index}`,
          index,
        ]),
      ),
      totalActiveMetrics: 30,
      matchedMetrics: 30,
      prefiltered: true,
      matchMode: 'sample',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'Show 10 random active metrics for this ship.',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        'I found 30 matched telemetry metrics. Showing 10 sample metrics [Telemetry]:',
      ),
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
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
    llmService.generateResponse.mockResolvedValue({
      content: 'Check the documented dipstick range before taking action.',
      responseId: 'resp_guidance_1',
    });

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
        answerRoute: 'llm_generation',
        resolvedSubjectQuery: 'Based on the current oil level, what should I do next?',
        llmResponseId: 'resp_guidance_1',
        usedLlm: true,
        usedDocumentation: true,
        usedCurrentTelemetry: true,
        usedHistoricalTelemetry: false,
      }),
      expect.any(Array),
    );
  });

  it('returns a telemetry-only unavailable answer instead of manual fallback for explicit telemetry-source alarm history queries', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content:
            'when and which was the bilge alarm last activated based on the telemetry',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'bilgmon488_instruction_manual_vAE - 2020.pdf',
          sourceCategory: 'MANUALS',
          snippet:
            'Downloading the operating log of BilgMon488 can be done through a USB-interface.',
          pageNumber: 5,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery:
        'when and which was the bilge alarm last activated based on the telemetry',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {},
      totalActiveMetrics: 24,
      matchedMetrics: 0,
      prefiltered: false,
      matchMode: 'none',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'when and which was the bilge alarm last activated based on the telemetry',
      'Sea Wolf X',
      'user',
    );

    expect(metricsService.getShipTelemetryContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      'when and which was the bilge alarm last activated based on the telemetry',
      undefined,
    );
    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      "I couldn't determine the requested answer from direct matched telemetry data.",
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
      }),
      [],
    );
  });

  it('returns a telemetry-only unavailable answer when current telemetry matches exist but do not answer the requested event query', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content:
            'when and which was the bilge alarm last activated based on the telemetry',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'bilgmon488_instruction_manual_vAE - 2020.pdf',
          sourceCategory: 'MANUALS',
          snippet:
            'Downloading the operating log of BilgMon488 can be done through a USB-interface.',
          pageNumber: 5,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery:
        'when and which was the bilge alarm last activated based on the telemetry',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Bilge-Alarms.BILGE ALARM 1': 0,
        'Bilge-Alarms.BILGE ALARM 2': 0,
      },
      totalActiveMetrics: 24,
      matchedMetrics: 12,
      prefiltered: true,
      matchMode: 'direct',
      clarification: null,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'when and which was the bilge alarm last activated based on the telemetry',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      "I couldn't determine the requested answer from direct matched telemetry data.",
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
      }),
      [],
    );
  });

  it('passes the latest LLM response id from the immediately preceding assistant turn', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What is the role of DPA?',
          ragflowContext: null,
        },
        {
          role: 'assistant',
          content: 'The DPA approves amendments and ensures current texts are kept.',
          ragflowContext: {
            answerRoute: 'llm_generation',
            usedLlm: true,
            usedDocumentation: true,
            llmResponseId: 'resp_prev_123',
            resolvedSubjectQuery: 'what is the role of dpa?',
          },
        },
        {
          role: 'user',
          content: 'Summarize that in one line.',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'JMS 01 SMS ADMINISTRATION 2 March 26.pdf',
          snippet:
            'Responsibility It is the responsibility of the Designated Person Ashore to approve amendments and to ensure that the most recent texts are kept in all locations.',
        },
      ],
      previousUserQuery: 'What is the role of DPA?',
      retrievalQuery: 'Summarize that in one line.',
      resolvedSubjectQuery: 'what is the role of dpa?',
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
    llmService.generateResponse.mockResolvedValue('The DPA keeps documentation current.');

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'Summarize that in one line.',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        previousResponseId: 'resp_prev_123',
      }),
    );
  });

  it('carries forward regulation citations for summary follow-ups instead of drifting to fresh certificate retrieval', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What is the role of DPA?',
          ragflowContext: null,
        },
        {
          role: 'assistant',
          content:
            'The DPA approves amendments and ensures current texts are kept.',
          ragflowContext: {
            answerRoute: 'llm_generation',
            usedLlm: true,
            usedDocumentation: true,
            llmResponseId: 'resp_prev_123',
            resolvedSubjectQuery: 'what is the role of dpa?',
          },
          contextReferences: [
            {
              shipManualId: 'manual-reg-1',
              shipManual: {
                shipId: 'ship-1',
                category: 'REGULATION',
              },
              chunkId: 'chunk-reg-1',
              score: 0.99,
              pageNumber: 29,
              snippet:
                'Responsibility It is the responsibility of the Designated Person Ashore to approve amendments and to ensure that the most recent texts are kept in all locations.',
              sourceTitle: 'JMS 01 SMS ADMINISTRATION 2 March 26.pdf',
              sourceUrl: null,
            },
          ],
        },
        {
          role: 'user',
          content: 'Summarize that in one line.',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          shipManualId: 'manual-cert-1',
          chunkId: 'chunk-cert-1',
          pageNumber: 2,
          snippet: 'Certificate details for a line-throwing appliance.',
          sourceTitle:
            'VSS001970 - Ikaros 34 61 00 Line Thrower single Shot_SOLAS Certificato Mod. B.pdf',
          sourceCategory: 'CERTIFICATES',
        },
      ],
      previousUserQuery: 'what is the role of dpa?',
      retrievalQuery: 'what is the role of dpa?',
      resolvedSubjectQuery: 'what is the role of dpa?',
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
    llmService.generateResponse.mockResolvedValue(
      'The DPA approves SMS changes and must be informed during relevant emergencies.',
    );

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'Summarize that in one line.',
      'Sea Wolf X',
      'user',
    );

    const llmCall = llmService.generateResponse.mock.calls.at(-1)?.[0];
    expect(llmCall.citations).toEqual([
      expect.objectContaining({
        sourceTitle: 'JMS 01 SMS ADMINISTRATION 2 March 26.pdf',
        sourceCategory: 'REGULATION',
        pageNumber: 29,
      }),
    ]);
    expect(llmCall.citations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle:
            'VSS001970 - Ikaros 34 61 00 Line Thrower single Shot_SOLAS Certificato Mod. B.pdf',
        }),
      ]),
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'The DPA approves SMS changes and must be informed during relevant emergencies.',
      expect.objectContaining({
        answerRoute: 'llm_generation',
        sourceDiagnostics: expect.objectContaining({
          effectiveCategories: ['REGULATION'],
        }),
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'JMS 01 SMS ADMINISTRATION 2 March 26.pdf',
          sourceCategory: 'REGULATION',
        }),
      ]),
    );
  });

  it('carries forward manual citations for summary follow-ups instead of drifting to history snippets', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What manual says about replacing the fuel separator element?',
          ragflowContext: null,
        },
        {
          role: 'assistant',
          content:
            'The manual says to replace the separator element at the documented maintenance interval.',
          ragflowContext: {
            answerRoute: 'llm_generation',
            usedLlm: true,
            usedDocumentation: true,
            llmResponseId: 'resp_prev_manual_123',
            resolvedSubjectQuery:
              'what manual says about replacing the fuel separator element?',
          },
          contextReferences: [
            {
              shipManualId: 'manual-man-1',
              shipManual: {
                shipId: 'ship-1',
                category: 'MANUALS',
              },
              chunkId: 'chunk-man-1',
              score: 0.97,
              pageNumber: 80,
              snippet:
                'Replace the fuel separator element according to the documented service interval and procedure.',
              sourceTitle: 'Marine Application Handbook.pdf',
              sourceUrl: null,
            },
          ],
        },
        {
          role: 'user',
          content: 'Summarize that briefly.',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          shipManualId: 'manual-hist-1',
          chunkId: 'chunk-hist-1',
          pageNumber: 2,
          snippet:
            'Take readings of all tanks and compare values with the readings taken earlier.',
          sourceTitle: 'Procedures - Bunkering and Transfers (3).pdf',
          sourceCategory: 'HISTORY_PROCEDURES',
        },
      ],
      previousUserQuery:
        'what manual says about replacing the fuel separator element?',
      retrievalQuery:
        'what manual says about replacing the fuel separator element?',
      resolvedSubjectQuery:
        'what manual says about replacing the fuel separator element?',
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
    llmService.generateResponse.mockResolvedValue(
      'Replace the fuel separator element at the documented manual interval.',
    );

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'Summarize that briefly.',
      'Sea Wolf X',
      'user',
    );

    const llmCall = llmService.generateResponse.mock.calls.at(-1)?.[0];
    expect(llmCall.citations).toEqual([
      expect.objectContaining({
        sourceTitle: 'Marine Application Handbook.pdf',
        sourceCategory: 'MANUALS',
        pageNumber: 80,
      }),
    ]);
    expect(llmCall.citations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'Procedures - Bunkering and Transfers (3).pdf',
        }),
      ]),
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'Replace the fuel separator element at the documented manual interval.',
      expect.objectContaining({
        answerRoute: 'llm_generation',
        sourceDiagnostics: expect.objectContaining({
          effectiveCategories: ['MANUALS'],
        }),
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'Marine Application Handbook.pdf',
          sourceCategory: 'MANUALS',
        }),
      ]),
    );
  });

  it('adds compact source diagnostics to assistant ragflow context', async () => {
    await (service as any).addRoutedAssistantMessage({
      sessionId: 'session-1',
      content: 'Tank capacities are documented in SOPEP.',
      route: 'llm_generation',
      normalizedQuery: {
        rawQuery: 'show tank capacities for fuel tanks',
        normalizedQuery: 'show tank capacities for fuel tanks',
        retrievalQuery: 'show tank capacities for fuel tanks',
        effectiveQuery: 'show tank capacities for fuel tanks',
        followUpMode: 'standalone',
        operation: 'lookup',
        timeIntent: { kind: 'none' },
        sourceHints: ['DOCUMENTATION'],
        isClarificationReply: false,
        ambiguityFlags: [],
      },
      ragflowContext: {
        resolvedSubjectQuery: 'fuel tank capacities',
      },
      contextReferences: [
        {
          shipManualId: 'manual-1',
          chunkId: 'chunk-1',
          pageNumber: 49,
          sourceTitle: 'Seawolf X SOPEP.pdf',
          sourceCategory: 'MANUALS',
          sourceMetadataCategory: 'HISTORY_PROCEDURES',
          sourceMetadataCategoryLabel: 'History Procedures',
        },
        {
          shipManualId: 'manual-1',
          chunkId: 'chunk-2',
          pageNumber: 50,
          sourceTitle: 'Seawolf X SOPEP.pdf',
          sourceCategory: 'MANUALS',
          sourceMetadataCategory: 'HISTORY_PROCEDURES',
        },
      ],
    });

    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'Tank capacities are documented in SOPEP.',
      expect.objectContaining({
        answerRoute: 'llm_generation',
        sourceDiagnostics: {
          totalReferences: 2,
          distinctSourceCount: 1,
          effectiveCategories: ['MANUALS'],
          ragflowMetadataCategories: ['HISTORY_PROCEDURES'],
          mismatchSourceCount: 1,
          sources: [
            {
              sourceTitle: 'Seawolf X SOPEP.pdf',
              shipManualId: 'manual-1',
              effectiveSourceCategory: 'MANUALS',
              ragflowMetadataCategory: 'HISTORY_PROCEDURES',
              ragflowMetadataCategoryLabel: 'History Procedures',
              categoryAlignment: 'mismatch',
              pageNumbers: [49, 50],
              referenceCount: 2,
            },
          ],
        },
      }),
      expect.any(Array),
    );
  });

  it('includes source category in formatted message responses', () => {
    const response = (service as any).formatMessageResponse({
      id: 'assistant-1',
      role: 'assistant',
      content: 'Done.',
      ragflowContext: null,
      contextReferences: [
        {
          id: 'ref-1',
          shipManualId: 'manual-1',
          shipManual: {
            shipId: 'ship-1',
            category: 'CERTIFICATES',
          },
          chunkId: 'chunk-1',
          score: 0.98,
          pageNumber: 12,
          snippet: 'Certificate details',
          sourceTitle: 'Certificate.pdf',
          sourceUrl: null,
        },
      ],
      createdAt: new Date('2026-04-01T00:00:00.000Z'),
      deletedAt: null,
    });

    expect(response.contextReferences).toEqual([
      expect.objectContaining({
        shipManualId: 'manual-1',
        shipId: 'ship-1',
        sourceCategory: 'CERTIFICATES',
        sourceTitle: 'Certificate.pdf',
      }),
    ]);
  });

  it('passes compact structured conversation state from recent ragflow metadata into the LLM context', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: "who is vessel's dpa?",
          ragflowContext: null,
        },
        {
          role: 'assistant',
          content: 'The DPA contact is JMS.',
          ragflowContext: {
            answerRoute: 'llm_generation',
            usedLlm: true,
            usedDocumentation: true,
            resolvedSubjectQuery: "who is vessel's dpa?",
            normalizedQuery: {
              followUpMode: 'standalone',
              subject: 'vessel dpa',
            },
          },
        },
        {
          role: 'user',
          content: 'contacts',
          ragflowContext: null,
        },
        {
          role: 'assistant',
          content: 'I found multiple contacts that match this request.',
          ragflowContext: {
            answerRoute: 'deterministic_contact',
            usedLlm: false,
            usedDocumentation: true,
            resolvedSubjectQuery: 'vessel dpa contact details',
            normalizedQuery: {
              followUpMode: 'follow_up',
              subject: 'vessel dpa contact',
            },
          },
        },
        {
          role: 'user',
          content: 'what about the other one?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          snippet:
            'Franc Jansen - Monaco franc@jmsyachting.com Zoe Bolt Falconer - The Netherlands zoe@jmsyachting.com',
        },
      ],
      previousUserQuery: 'contacts',
      retrievalQuery: 'what about the other one?',
      resolvedSubjectQuery: 'vessel dpa contact details',
      answerQuery: undefined,
    });
    llmService.generateResponse.mockResolvedValue(
      'The other matching DPA contact is Zoe Bolt Falconer.',
    );

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'what about the other one?',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredConversationState: expect.stringContaining(
          'answerRoute=deterministic_contact',
        ),
      }),
    );
    expect(llmService.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredConversationState: expect.stringContaining(
          'resolvedSubject="vessel dpa contact details"',
        ),
      }),
    );
  });

  it('reuses previous contact citations and lets the LLM handle email-only follow-ups', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: "who is vessel's dpa?",
          ragflowContext: null,
        },
        {
          role: 'assistant',
          content:
            'I found multiple contacts that match this request in the provided documentation.',
          ragflowContext: {
            answerRoute: 'deterministic_contact',
            usedLlm: false,
            usedDocumentation: true,
            resolvedSubjectQuery: 'vessel dpa contact details',
            normalizedQuery: {
              followUpMode: 'follow_up',
              subject: 'vessel dpa contact',
            },
          },
          contextReferences: [
            {
              shipManualId: 'manual-1',
              chunkId: 'chunk-1',
              score: 0.97,
              pageNumber: 4,
              snippet:
                'Franc Jansen - Monaco franc@jmsyachting.com Zoe Bolt Falconer - The Netherlands zoe@jmsyachting.com',
              sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
              sourceUrl: null,
              shipManual: { shipId: 'ship-1' },
            },
          ],
        },
        {
          role: 'user',
          content: 'email only',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'SEAWOLF X - NTVRP 2025.pdf',
          snippet: 'DPA contact email candidates from an unrelated response plan.',
        },
      ],
      previousUserQuery: 'vessel dpa contact details',
      retrievalQuery: 'vessel dpa contact email',
      resolvedSubjectQuery: 'vessel dpa contact email',
      answerQuery: undefined,
    });
    llmService.generateResponse.mockResolvedValue(
      'The email I can confirm is franc@jmsyachting.com.',
    );

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'email only',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        citations: expect.arrayContaining([
          expect.objectContaining({
            sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          }),
        ]),
      }),
    );
    expect(llmService.generateResponse).not.toHaveBeenCalledWith(
      expect.objectContaining({
        citations: expect.arrayContaining([
          expect.objectContaining({
            sourceTitle: 'SEAWOLF X - NTVRP 2025.pdf',
          }),
        ]),
      }),
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      'The email I can confirm is franc@jmsyachting.com.',
      expect.objectContaining({
        answerRoute: 'llm_generation',
        resolvedSubjectQuery: 'vessel dpa contact email',
        usedLlm: true,
        usedDocumentation: true,
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
        }),
      ]),
    );
  });

  it('does not carry forward broad DPA citations before the contact sheet has been established', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: "who is vessel's dpa?",
          ragflowContext: null,
        },
        {
          role: 'assistant',
          content: 'The documented DPA contact is JMS Ltd.',
          ragflowContext: {
            answerRoute: 'llm_generation',
            usedLlm: true,
            usedDocumentation: true,
            resolvedSubjectQuery: "who is vessel's dpa?",
            normalizedQuery: {
              followUpMode: 'standalone',
              subject: 'vessel dpa',
            },
          },
          contextReferences: [
            {
              shipManualId: 'manual-legacy',
              chunkId: 'chunk-legacy',
              score: 0.8,
              pageNumber: 36,
              snippet: 'DPA - JMS Ltd / Jansen',
              sourceTitle: 'Seawolf X SOPEP.pdf',
              sourceUrl: null,
              shipManual: { shipId: 'ship-1' },
            },
          ],
        },
        {
          role: 'user',
          content: 'contacts',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          pageNumber: 4,
          snippet:
            'Franc Jansen - Monaco franc@jmsyachting.com Zoe Bolt Falconer - The Netherlands zoe@jmsyachting.com Tom Vannieuwenhuyse - Palma tom@jmsyachting.com',
        },
      ],
      previousUserQuery: "who is vessel's dpa?",
      retrievalQuery: 'vessel dpa contact details',
      resolvedSubjectQuery: 'vessel dpa contact details',
      answerQuery: undefined,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'contacts',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('Franc Jansen'),
      expect.objectContaining({
        answerRoute: 'deterministic_contact',
        resolvedSubjectQuery: 'vessel dpa contact details',
        usedLlm: false,
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
        }),
      ]),
    );
  });

  it('returns all matching DPA contacts from the cited contact sheet instead of collapsing to one person', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: "who is vessel's dpa?",
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          pageNumber: 4,
          snippet:
            'JMs Yachting Company Contact Details Franc Jansen - Monaco franc@jmsyachting.com JMS Founder, Director & DPA (M) +33 612 639 648 Sam Thompson - Monaco Commercial Director +33 784 123 373 sam@jmsyachting.com Zoe Bolt Falconer - The Netherlands Fleet Compliance Manager, DPA & CSO (M) +31 633 010 685 zoe@jmsyachting.com Tom Vannieuwenhuyse - Palma Fleet Manager DPA/CSO (M) +34 666 884 852 tom@jmsyachting.com',
        },
      ],
      previousUserQuery: "who is vessel's dpa?",
      retrievalQuery: 'who vessel dpa contact details',
      resolvedSubjectQuery: 'who vessel dpa contact details',
      answerQuery: 'who vessel dpa contact details',
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'provide his contacts',
      'Sea Wolf X',
      'user',
    );

    const content = (
      service.addAssistantMessage as jest.Mock
    ).mock.calls.at(-1)?.[1];

    expect(content).toContain('Franc Jansen');
    expect(content).toContain('Zoe Bolt Falconer');
    expect(content).toContain('Tom Vannieuwenhuyse');
    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(metricsService.getShipTelemetryContextForQuery).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.any(String),
      expect.objectContaining({
        answerRoute: 'deterministic_contact',
        resolvedSubjectQuery: 'who vessel dpa contact details',
        usedLlm: false,
        usedDocumentation: true,
        usedCurrentTelemetry: false,
        usedHistoricalTelemetry: false,
      }),
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
        }),
      ]),
    );
  });

  it('lists unique roles from the cited contact sheet for role-inventory follow-ups', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: "who is vessel's dpa?",
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          pageNumber: 4,
          snippet:
            'JMs Yachting Company Contact Details Franc Jansen - Monaco franc@jmsyachting.com JMS Founder, Director & DPA (M) +33 612 639 648 Sam Thompson - Monaco Commercial Director +33 784 123 373 sam@jmsyachting.com Zoe Bolt Falconer - The Netherlands Fleet Compliance Manager, DPA & CSO (M) +31 633 010 685 zoe@jmsyachting.com Tom Vannieuwenhuyse - Palma Fleet Manager DPA/CSO (M) +34 666 884 852 tom@jmsyachting.com',
        },
      ],
      previousUserQuery: "who is vessel's dpa?",
      retrievalQuery: 'who vessel dpa roles',
      resolvedSubjectQuery: 'who vessel dpa roles',
      answerQuery: 'who vessel dpa roles',
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'what other roles are there?',
      'Sea Wolf X',
      'user',
    );

    const content = (
      service.addAssistantMessage as jest.Mock
    ).mock.calls.at(-1)?.[1];

    expect(content).toContain('JMS Founder, Director & DPA');
    expect(content).toContain('Commercial Director');
    expect(content).toContain('Fleet Compliance Manager, DPA & CSO');
    expect(content).toContain('Fleet Manager DPA/CSO');
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('returns all people holding a role instead of switching to a role-description answer', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: "who is vessel's dpa?",
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          pageNumber: 4,
          snippet:
            'JMs Yachting Company Contact Details Franc Jansen - Monaco franc@jmsyachting.com JMS Founder, Director & DPA (M) +33 612 639 648 Sam Thompson - Monaco Commercial Director +33 784 123 373 sam@jmsyachting.com Zoe Bolt Falconer - The Netherlands Fleet Compliance Manager, DPA & CSO (M) +31 633 010 685 zoe@jmsyachting.com Tom Vannieuwenhuyse - Palma Fleet Manager DPA/CSO (M) +34 666 884 852 tom@jmsyachting.com',
        },
      ],
      previousUserQuery: "who is vessel's dpa?",
      retrievalQuery: 'dpa contact details',
      resolvedSubjectQuery: 'dpa contact details',
      answerQuery: undefined,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'who else has the dpa role?',
      'Sea Wolf X',
      'user',
    );

    const content = (
      service.addAssistantMessage as jest.Mock
    ).mock.calls.at(-1)?.[1];

    expect(content).toContain('Franc Jansen');
    expect(content).toContain('Zoe Bolt Falconer');
    expect(content).toContain('Tom Vannieuwenhuyse');
    expect(content).not.toContain('responsibility');
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('returns all people matching another requested role from the cited contact sheet', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'list all managers',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          pageNumber: 4,
          snippet:
            'JMs Yachting Company Contact Details Franc Jansen - Monaco franc@jmsyachting.com JMS Founder, Director & DPA (M) +33 612 639 648 Sam Thompson - Monaco Commercial Director +33 784 123 373 sam@jmsyachting.com Zoe Bolt Falconer - The Netherlands Fleet Compliance Manager, DPA & CSO (M) +31 633 010 685 zoe@jmsyachting.com Tom Vannieuwenhuyse - Palma Fleet Manager DPA/CSO (M) +34 666 884 852 tom@jmsyachting.com',
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'list all managers',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'list all managers',
      'Sea Wolf X',
      'user',
    );

    const content = (
      service.addAssistantMessage as jest.Mock
    ).mock.calls.at(-1)?.[1];

    expect(content).toContain('Zoe Bolt Falconer');
    expect(content).toContain('Tom Vannieuwenhuyse');
    expect(content).not.toContain('Sam Thompson');
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('mentions when a personnel-directory answer is truncated by the output limit', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'list all managers with their contact details',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          pageNumber: 4,
          snippet:
            'Alice Smith - Monaco Fleet Manager (M) +33 100 000 001 alice@jmsyachting.com Bob Jones - Palma Technical Manager (M) +33 100 000 002 bob@jmsyachting.com Carol White - Dubai Operations Manager (M) +33 100 000 003 carol@jmsyachting.com David Black - London Marketing Manager (M) +33 100 000 004 david@jmsyachting.com Emma Green - Nice HR Manager (M) +33 100 000 005 emma@jmsyachting.com Frank Brown - Miami Yacht Manager (M) +33 100 000 006 frank@jmsyachting.com Grace Blue - Rome Commercial Manager (M) +33 100 000 007 grace@jmsyachting.com Hannah Gold - UK Office Manager (M) +33 100 000 008 hannah@jmsyachting.com Ian Silver - Malta Service Manager (M) +33 100 000 009 ian@jmsyachting.com Julia Red - Lisbon Compliance Manager (M) +33 100 000 010 julia@jmsyachting.com Kate Grey - Athens Crew Manager (M) +33 100 000 011 kate@jmsyachting.com Liam White - Monaco Project Manager (M) +33 100 000 012 liam@jmsyachting.com Mike Orange - Palma Technical Manager (M) +33 100 000 013 mike@jmsyachting.com',
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'manager contact details',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'list all managers with their contact details',
      'Sea Wolf X',
      'user',
    );

    const content = (service.addAssistantMessage as jest.Mock).mock.calls[0][1];

    expect(content).toContain('Showing the first 12 of 13 matching contacts.');
    expect(content).toContain('additional contact is listed in the source document.');
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('prefers the dedicated contact sheet over noisy operational-plan contacts for manager lists', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'list all managers with their contact details',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'SEAWOLF X - NTVRP 2025.pdf',
          pageNumber: 12,
          snippet:
            'Federal On - Insurance Manager 3.Notify P&I representatives. Registrar General - DPA authorities of the relevant flag state shipping.master@cishipping.com +1345 815 1605',
          score: 0.99,
        },
        {
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          pageNumber: 4,
          snippet:
            'James Kirby - Fleet Manager (M) +34 680 664 753 jamesk@jmsyachting.com Carla Swaine - HR Manager Global HSQE (M) +44 7494 320 951 carla@jmsyachting.com Zoe Bolt Falconer - Fleet Compliance Manager, DPA & CSO (M) +31 633 010 685 zoe@jmsyachting.com',
          score: 0.95,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'manager contact details',
      resolvedSubjectQuery: 'manager contact details',
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
      'list all managers with their contact details',
      'Sea Wolf X',
      'user',
    );

    const content = (service.addAssistantMessage as jest.Mock).mock.calls.at(-1)?.[1];
    const contextRefs = (service.addAssistantMessage as jest.Mock).mock.calls.at(-1)?.[3];

    expect(content).toContain('James Kirby');
    expect(content).toContain('Carla Swaine');
    expect(content).not.toContain('Federal On');
    expect(content).not.toContain('shipping.master@cishipping.com');
    expect(content).toContain('JMS Company Contact Details Jan 26.pdf');
    expect(contextRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
        }),
      ]),
    );
    expect(contextRefs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceTitle: 'SEAWOLF X - NTVRP 2025.pdf',
        }),
      ]),
    );
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('merges partial duplicate contact rows from the same contact sheet before answering manager lists', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'list all managers with their contact details',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          pageNumber: 4,
          snippet:
            'Arne Jansson - Yacht Manager (M) +34 649 231 000 arne@jmsyachting.com James Kirby - Fleet Manager (M) +34 680 664 753 jamesk@jmsyachting.com',
          score: 0.95,
        },
        {
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          pageNumber: 4,
          snippet: 'Arne Jansson - Yacht Manager - +34 649 23',
          score: 0.92,
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'manager contact details',
      resolvedSubjectQuery: 'manager contact details',
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
      'list all managers with their contact details',
      'Sea Wolf X',
      'user',
    );

    const content = (service.addAssistantMessage as jest.Mock).mock.calls.at(-1)?.[1];
    expect(content).toContain(
      'Arne Jansson - Yacht Manager - +34 649 231 000 - arne@jmsyachting.com',
    );
    expect(content).not.toMatch(
      /Arne Jansson - Yacht Manager - \+34 649 23(?:\s|$)/,
    );
    expect(content.match(/Arne Jansson/g)?.length).toBe(1);
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('keeps role-description questions on the documentation-answer path instead of forcing a directory lookup', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'what is the role of dpa?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'JMS 01 SMS ADMINISTRATION 2 March 26.pdf',
          pageNumber: 29,
          snippet:
            'Responsibility It is the responsibility of the Designated Person Ashore to approve amendments and to ensure that the most recent texts are kept in all locations.',
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'what is the role of dpa?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    llmService.generateResponse.mockResolvedValue(
      'The DPA is responsible for approving amendments and ensuring the most recent texts are kept in all locations.',
    );

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'what is the role of dpa?',
      'Sea Wolf X',
      'user',
    );

    expect(llmService.generateResponse).toHaveBeenCalled();
  });

  it('returns director contacts from the company contact details document without asking for more clarification', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'show all directors from the company contact details document',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [
        {
          sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
          pageNumber: 4,
          snippet:
            'JMs Yachting Company Contact Details Franc Jansen - Monaco franc@jmsyachting.com JMS Founder, Director & DPA (M) +33 612 639 648 Sam Thompson - Monaco Commercial Director, Director of JMS Careers (M) +33 784 123 373 sam@jmsyachting.com Rob Pijper - Palma Operations Director (M) +31 636 219 315 rob@jmsyachting.com Lucia Badano - Palma Technical Director (M) +34 689 300533 lucia@jmsyachting.com',
        },
      ],
      previousUserQuery: undefined,
      retrievalQuery: 'director contact details',
      resolvedSubjectQuery: 'director contact details',
      answerQuery: undefined,
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'show all directors from the company contact details document',
      'Sea Wolf X',
      'user',
    );

    const content = (
      service.addAssistantMessage as jest.Mock
    ).mock.calls.at(-1)?.[1];

    expect(content).toContain('Franc Jansen');
    expect(content).toContain('Sam Thompson');
    expect(content).toContain('Rob Pijper');
    expect(content).toContain('Lucia Badano');
    expect(content).not.toContain('Please clarify');
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('uses the resolved telemetry subject for a current-time follow-up after a historical aggregate answer', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'how much total fuel was 5 days ago?',
          ragflowContext: null,
        },
        {
          role: 'assistant',
          content: 'At 2026-03-28 11:15 UTC, the historical total was ...',
          ragflowContext: {
            answerRoute: 'historical_telemetry',
            resolvedSubjectQuery: 'how much total fuel was 5 days ago show all available',
          },
        },
        {
          role: 'user',
          content: 'you missed 3 tanks',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: 'how much total fuel was 5 days ago show all available',
      retrievalQuery: 'how much total fuel is in the tanks right now',
      resolvedSubjectQuery: 'how much total fuel is in the tanks right now',
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Fuel Tank 1P': 3747,
        'Fuel Tank 2S': 3522,
        'Fuel Tank 3P': 416,
        'Fuel Tank 4S': 324,
        'Fuel Tank 5P': 799,
        'Fuel Tank 6S': 920,
        'Fuel Tank 7P': 1254,
        'Fuel Tank 8S': 1236,
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
      'what about now?',
      'Sea Wolf X',
      'user',
    );

    expect(metricsService.getShipTelemetryContextForQuery).toHaveBeenCalledWith(
      'ship-1',
      'what about now?',
      'how much total fuel is in the tanks right now',
    );
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        'The combined total from the current matched telemetry readings is 12,218',
      ),
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        resolvedSubjectQuery: 'how much total fuel is in the tanks right now',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
      }),
      [],
    );
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('answers vague aggregate follow-ups deterministically even when the carried subject omits sum wording', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'Show fuel tank levels for Sea Wolf X',
          ragflowContext: null,
        },
        {
          role: 'assistant',
          content: 'The current matched telemetry readings are [Telemetry]: ...',
          ragflowContext: {
            answerRoute: 'current_telemetry',
            resolvedSubjectQuery: 'Show fuel tank levels for Sea Wolf X',
          },
        },
        {
          role: 'user',
          content: 'what the sum',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: 'Show fuel tank levels for Sea Wolf X',
      retrievalQuery: 'Show fuel tank levels for Sea Wolf X',
      resolvedSubjectQuery: 'Show fuel tank levels for Sea Wolf X',
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Fuel Tank 1P': 3767,
        'Fuel Tank 2S': 3543,
        'Fuel Tank 3P': 462,
        'Fuel Tank 4S': 352,
        'Fuel Tank 5P': 799,
        'Fuel Tank 6S': 902,
        'Fuel Tank 7P': 752,
        'Fuel Tank 8S': 846,
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
      'what the sum',
      'Sea Wolf X',
      'admin',
    );

    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        'The combined total from the current matched telemetry readings is 11,423',
      ),
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        telemetryFollowUpQuery: expect.stringContaining('how much total'),
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
      }),
      [],
    );
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('keeps current inventory telemetry deterministic for follow-ups phrased as fuel level in the tanks', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'what was the fuel level 5 days ago',
          ragflowContext: null,
        },
        {
          role: 'assistant',
          content: 'At 2026-03-31 19:03 UTC, the historical total was ...',
          ragflowContext: {
            answerRoute: 'historical_telemetry',
            resolvedSubjectQuery: 'what is the fuel level in the tanks right now',
          },
        },
        {
          role: 'user',
          content: 'what about now?',
          ragflowContext: null,
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: 'what is the fuel level in the tanks right now',
      retrievalQuery: 'what is the fuel level in the tanks right now',
      resolvedSubjectQuery: 'what is the fuel level in the tanks right now',
      answerQuery: undefined,
    });
    metricsService.getShipTelemetryContextForQuery.mockResolvedValue({
      telemetry: {
        'Fuel Tank 1P': 3767,
        'Fuel Tank 2S': 3543,
        'Fuel Tank 3P': 462,
        'Fuel Tank 4S': 352,
        'Fuel Tank 5P': 799,
        'Fuel Tank 6S': 902,
        'Fuel Tank 7P': 752,
        'Fuel Tank 8S': 846,
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
      'what about now?',
      'Sea Wolf X',
      'user',
    );

    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining(
        'The current matched telemetry readings are [Telemetry]:',
      ),
      expect.objectContaining({
        answerRoute: 'current_telemetry',
        telemetryFollowUpQuery: 'what is the fuel level in the tanks right now',
        usedLlm: false,
        usedDocumentation: false,
        usedCurrentTelemetry: true,
      }),
      [],
    );
    expect(llmService.generateResponse).not.toHaveBeenCalled();
  });

  it('does not fall back to telemetry when a locked documentation source has no evidence', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content:
            'From Selected Procedure.pdf document: What should I do before starting it?',
          ragflowContext: null,
          contextReferences: [],
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery:
        'From Selected Procedure.pdf document: What should I do before starting it?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
      sourceLockActive: true,
      documentationFollowUpState: {
        manualId: 'manual-1',
        documentId: 'document-1',
        filename: 'Selected Procedure.pdf',
        sourceLock: true,
      },
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'From Selected Procedure.pdf document: What should I do before starting it?',
      'Sea Wolf X',
      'user',
    );

    expect(metricsService.resolveHistoricalTelemetryQuery).not.toHaveBeenCalled();
    expect(metricsService.getShipTelemetryContextForQuery).not.toHaveBeenCalled();
    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining('selected source'),
      expect.objectContaining({
        answerRoute: 'deterministic_document',
        noDocumentation: true,
        sourceLockNoEvidence: true,
        usedCurrentTelemetry: false,
      }),
      [],
    );
  });

  it('does not fall back to LLM when semantic documentation retrieval has no evidence', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'What are the UPS operating modes?',
          ragflowContext: null,
          contextReferences: [],
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'What are the UPS operating modes?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
      sourceLockActive: false,
      semanticQuery: {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'general_information',
        conceptFamily: 'asset_system',
        selectedConceptIds: ['tag:equipment:electrical:ups'],
        candidateConceptIds: ['tag:equipment:electrical:ups'],
        equipment: [],
        systems: [],
        vendor: null,
        model: null,
        sourcePreferences: ['MANUALS'],
        explicitSource: null,
        pageHint: null,
        sectionHint: null,
        answerFormat: 'direct_answer',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.78,
      },
      retrievalTrace: {
        rawQuery: 'What are the UPS operating modes?',
        retrievalQuery: 'What are the UPS operating modes?',
        semanticIntent: 'general_information',
        semanticConceptIds: ['tag:equipment:electrical:ups'],
        semanticConfidence: 0.78,
        candidateConceptIds: ['tag:equipment:electrical:ups'],
        sourcePreferences: ['MANUALS'],
        explicitSource: null,
        lockedManualId: null,
        lockedManualTitle: null,
        sourceLockActive: false,
        pageHint: null,
        sectionHint: null,
        shortlistedManualIds: ['manual-ups'],
        shortlistedManualTitles: ['UPS manual.pdf'],
        fallbackWideningUsed: true,
      },
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'What are the UPS operating modes?',
      'Sea Wolf X',
      'user',
    );

    expect(metricsService.getShipTelemetryContextForQuery).not.toHaveBeenCalled();
    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining("couldn't find supporting documentation"),
      expect.objectContaining({
        answerRoute: 'deterministic_document',
        noDocumentation: true,
        documentationNoEvidence: true,
        usedCurrentTelemetry: false,
      }),
      [],
    );
  });

  it('does not fall back to LLM for procedure-style documentation misses without semantic anchors', async () => {
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: 'How should I enter an enclosed space safely?',
          ragflowContext: null,
          contextReferences: [],
        },
      ],
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: undefined,
      retrievalQuery: 'How should I enter an enclosed space safely?',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
      sourceLockActive: false,
      semanticQuery: {
        schemaVersion: '2026-04-06.semantic-v2',
        intent: 'general_information',
        conceptFamily: 'asset_system',
        selectedConceptIds: [],
        candidateConceptIds: [],
        equipment: [],
        systems: [],
        vendor: null,
        model: null,
        sourcePreferences: ['MANUALS'],
        explicitSource: null,
        pageHint: null,
        sectionHint: null,
        answerFormat: 'step_by_step',
        needsClarification: false,
        clarificationReason: null,
        confidence: 0.42,
      },
      retrievalTrace: {
        rawQuery: 'How should I enter an enclosed space safely?',
        retrievalQuery: 'How should I enter an enclosed space safely?',
        semanticIntent: 'general_information',
        semanticConceptIds: [],
        semanticConfidence: 0.42,
        candidateConceptIds: [],
        sourcePreferences: ['MANUALS'],
        explicitSource: null,
        lockedManualId: null,
        lockedManualTitle: null,
        sourceLockActive: false,
        pageHint: null,
        sectionHint: null,
        shortlistedManualIds: [],
        shortlistedManualTitles: [],
        fallbackWideningUsed: true,
      },
    });

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'How should I enter an enclosed space safely?',
      'Sea Wolf X',
      'user',
    );

    expect(metricsService.getShipTelemetryContextForQuery).not.toHaveBeenCalled();
    expect(llmService.generateResponse).not.toHaveBeenCalled();
    expect(service.addAssistantMessage).toHaveBeenCalledWith(
      'session-1',
      expect.stringContaining("couldn't find supporting documentation"),
      expect.objectContaining({
        answerRoute: 'deterministic_document',
        noDocumentation: true,
        documentationNoEvidence: true,
        usedCurrentTelemetry: false,
      }),
      [],
    );
  });

  it('builds documentation history from the latest turns in chronological order', async () => {
    const returnedMessages = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message-${index + 3}`,
      ragflowContext: null,
      contextReferences: [],
    })).reverse();
    prisma.chatSession.findUnique.mockResolvedValue({
      messages: returnedMessages,
    });
    documentationService.prepareDocumentationContext.mockResolvedValue({
      citations: [],
      previousUserQuery: 'message-21',
      retrievalQuery: 'Summarize that as a checklist.',
      resolvedSubjectQuery: undefined,
      answerQuery: undefined,
    });
    llmService.generateResponse.mockResolvedValue('Summary from latest topic.');

    await (service as any).generateAssistantResponse(
      'ship-1',
      'session-1',
      'Summarize that as a checklist.',
      'Sea Wolf X',
      'user',
    );

    expect(prisma.chatSession.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          messages: expect.objectContaining({
            orderBy: { createdAt: 'desc' },
            take: 20,
          }),
        }),
      }),
    );
    expect(
      documentationService.prepareDocumentationContext.mock.calls[0][0]
        .messageHistory.map((message: { content: string }) => message.content),
    ).toEqual(Array.from({ length: 20 }, (_, index) => `message-${index + 3}`));
  });
});
