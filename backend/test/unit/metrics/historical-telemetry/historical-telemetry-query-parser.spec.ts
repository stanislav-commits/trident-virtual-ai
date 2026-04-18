import { parseHistoricalTelemetryRequest } from '../../../../src/telemetry-catalog/historical-telemetry/historical-telemetry-query-parser';

const parse = (
  query: string,
  overrides: Partial<Parameters<typeof parseHistoricalTelemetryRequest>[0]> = {},
) =>
  parseHistoricalTelemetryRequest({
    query,
    isTelemetryLocationQuery: () => false,
    isImplicitDailyStoredFluidUsageQuery: () => false,
    ...overrides,
  });

describe('historical telemetry query parser', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-27T12:00:00.000Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('asks for clarification when a date is missing the year', () => {
    const parsed = parse('What was the yacht position on 14 March?', {
      isTelemetryLocationQuery: () => true,
    });

    expect(parsed?.operation).toBe('position');
    expect(parsed?.clarificationQuestion).toBe(
      'Which year do you mean for 14 March?',
    );
  });

  it('allows single-day historical position lookups without exact time', () => {
    const parsed = parse('What was the yacht position on 14 March 2026?', {
      isTelemetryLocationQuery: () => true,
    });

    expect(parsed?.operation).toBe('position');
    expect(parsed?.rangeLabel).toBe('2026-03-14 UTC');
    expect(parsed?.range.start.toISOString()).toBe('2026-03-14T00:00:00.000Z');
    expect(parsed?.range.stop.toISOString()).toBe('2026-03-14T23:59:59.999Z');
  });

  it('rejects forecast planning phrasing that only looks historical', () => {
    expect(
      parse('How much fuel was used over the last 30 days for next month order'),
    ).toBeNull();
  });

  it('parses event-style historical telemetry requests', () => {
    const parsed = parse('When was the last bunkering?', {
      normalizedQuery: {
        operation: 'event',
        timeIntent: { kind: 'none', eventType: 'bunkering' },
      } as never,
    });

    expect(parsed?.operation).toBe('event');
    expect(parsed?.eventType).toBe('bunkering');
    expect(parsed?.metricQuery).toBe('When bunkering');
    expect(parsed?.rangeLabel).toBe(
      '2025-09-27 12:00 UTC to 2026-03-27 12:00 UTC',
    );
  });
});
