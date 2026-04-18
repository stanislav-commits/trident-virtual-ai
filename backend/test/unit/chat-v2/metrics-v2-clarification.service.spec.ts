import { MetricsV2ClarificationService } from '../../../src/metrics-v2/execution/metrics-v2-clarification.service';

describe('MetricsV2ClarificationService', () => {
  it('localizes ambiguous metric clarification to Ukrainian', async () => {
    const fallbackWriter = {
      write: jest.fn(async () =>
        'Я знайшов кілька схожих метрик, які можуть підходити під цей запит. Яку саме ти маєш на увазі?',
      ),
    };
    const service = new MetricsV2ClarificationService(fallbackWriter as any);

    const clarification = await service.extractClarification(
      {
        requests: [
          {
            plan: {} as any,
            entries: [],
            clarificationKind: 'ambiguous_metrics',
            clarificationOptions: ['Metric A', 'Metric B'],
          },
        ],
      },
      'uk',
    );

    expect(clarification?.question).toBe(
      'Я знайшов кілька схожих метрик, які можуть підходити під цей запит. Яку саме ти маєш на увазі?',
    );
    expect(clarification?.options).toEqual(['Metric A', 'Metric B']);
  });
});
