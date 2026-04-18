import { MetricsV2ClarificationContinuationService } from '../../../src/metrics-v2/metrics-v2-clarification-continuation.service';
import { AssistantCanonicalCopyService } from '../../../src/assistant-text/assistant-canonical-copy.service';

describe('MetricsV2ClarificationContinuationService', () => {
  const pendingClarification = {
    id: 'clar-1',
    domain: 'metrics_v2' as const,
    kind: 'ambiguous_metrics' as const,
    language: 'uk' as const,
    question: 'Яку саме метрику швидкості ти маєш на увазі?',
    originalUserQuery: 'Яка швидкість поточна яхти',
    createdAtIso: '2026-04-17T18:00:00.000Z',
    requestId: 'speed_now',
    requestPlan: {
      requestId: 'speed_now',
      source: 'current',
      shape: 'single',
      concept: 'vessel_speed',
    },
    options: [
      {
        id: 'speed_now:1',
        label: 'Speed Over Ground',
        metricKey: 'nav.sog',
        source: 'current' as const,
      },
      {
        id: 'speed_now:2',
        label: 'Speed Through Water',
        metricKey: 'nav.stw',
        source: 'current' as const,
      },
    ],
  };

  it('shows saved options for a clarification follow-up', async () => {
    const localizer = {
      localize: jest.fn(async ({ canonicalText }: { canonicalText: string }) =>
        canonicalText
          .replace(
            'I found these candidate metrics:',
            'Я знайшов такі варіанти метрик:',
          )
          .replace(
            'Reply with the number or the name of the metric you want.',
            'Напиши номер або назву потрібної метрики.',
          ),
      ),
    };
    const service = new MetricsV2ClarificationContinuationService(
      { loadShipCatalog: jest.fn() } as any,
      { execute: jest.fn() } as any,
      { compose: jest.fn() } as any,
      new AssistantCanonicalCopyService(),
      localizer as any,
    );

    const result = await service.handle({
      turnContext: {
        sessionId: 'session-1',
        shipId: 'ship-1',
        userQuery: 'які ти знайшов',
        messageHistory: [],
        previousMessages: [],
        shipOrganizationName: 'Sea Wolf X',
      },
      pendingClarification,
      decision: {
        intent: 'show_options',
        reason: 'The user asked to list the options.',
      },
    });

    expect(result.handled).toBe(true);
    expect(result.draft?.usedLlm).toBe(false);
    expect(result.draft?.content).toContain('Я знайшов такі варіанти метрик:');
    expect(result.draft?.content).toContain('1. Speed Over Ground');
    expect(result.draft?.content).toContain('2. Speed Through Water');
    expect(result.draft?.extraContext?.pendingClarification).toEqual(
      pendingClarification,
    );
  });

  it('executes the selected option and resolves the clarification', async () => {
    const loadShipCatalog = jest.fn().mockResolvedValue([
      {
        key: 'nav.sog',
        label: 'Speed Over Ground',
        latestValue: 14.2,
        searchText: 'speed over ground',
        operationalMeaning: 'Current vessel speed over ground',
        semanticSummary: 'Current SOG',
        businessConcept: 'vessel_speed',
        measurementKind: 'speed',
        unitKind: 'speed',
        aggregationCompatibility: [],
        semanticConfidence: 0.99,
      },
    ]);
    const execute = jest.fn().mockResolvedValue({
      requests: [{ entries: [{ key: 'nav.sog' }] }],
    });
    const compose = jest.fn().mockReturnValue({
      content: 'Поточна швидкість яхти: 14.2 kn.',
      sourceOfTruth: 'current_metrics',
      usedCurrentMetrics: true,
      usedHistoricalMetrics: false,
    });
    const localizer = {
      localize: jest.fn(
        async ({ canonicalText }: { canonicalText: string }) => canonicalText,
      ),
    };

    const service = new MetricsV2ClarificationContinuationService(
      { loadShipCatalog } as any,
      { execute } as any,
      { compose } as any,
      new AssistantCanonicalCopyService(),
      localizer as any,
    );

    const result = await service.handle({
      turnContext: {
        sessionId: 'session-1',
        shipId: 'ship-1',
        userQuery: 'перша',
        messageHistory: [],
        previousMessages: [],
        shipOrganizationName: 'Sea Wolf X',
      },
      pendingClarification,
      decision: {
        intent: 'select_option',
        selectedOptionId: 'speed_now:1',
        reason: 'The user selected the first option.',
      },
    });

    expect(result.handled).toBe(true);
    expect(loadShipCatalog).toHaveBeenCalledWith('ship-1');
    expect(execute).toHaveBeenCalled();
    expect(compose).toHaveBeenCalled();
    expect(result.draft?.content).toBe('Поточна швидкість яхти: 14.2 kn.');
    expect(result.draft?.usedCurrentTelemetry).toBe(true);
    expect(result.draft?.extraContext?.clarificationResolved).toBe(true);
  });
});
