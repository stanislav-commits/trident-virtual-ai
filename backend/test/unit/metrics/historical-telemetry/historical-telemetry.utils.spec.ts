import {
  buildFullDayHistoricalRange,
  formatAggregateNumber,
  formatHistoricalDayOrRange,
  formatHistoricalRange,
  formatSignedAggregateNumber,
  isHistoricalQueryTimeout,
  parseExplicitHistoricalDate,
  parseHistoricalNumericValue,
  parseHistoricalTimeOfDay,
  parseRelativeHistoricalRange,
} from '../../../../src/metrics/historical-telemetry/historical-telemetry.utils';

describe('historical telemetry utils', () => {
  beforeAll(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-27T12:00:00.000Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  it('parses explicit dates and historical times', () => {
    expect(parseExplicitHistoricalDate('on 14 March 2026')?.toISOString()).toBe(
      '2026-03-14T00:00:00.000Z',
    );
    expect(parseExplicitHistoricalDate('March 14, 2026')?.toISOString()).toBe(
      '2026-03-14T00:00:00.000Z',
    );
    expect(parseHistoricalTimeOfDay('at 7:30 pm UTC')).toEqual({
      hours: 19,
      minutes: 30,
    });
  });

  it('builds and formats day/range windows', () => {
    const day = buildFullDayHistoricalRange(
      new Date('2026-03-14T00:00:00.000Z'),
    );
    expect(formatHistoricalDayOrRange(day)).toBe('2026-03-14 UTC');
    expect(formatHistoricalRange(day)).toBe(
      '2026-03-14 00:00 UTC to 2026-03-14 23:59 UTC',
    );
  });

  it('parses relative ranges from the current clock', () => {
    const range = parseRelativeHistoricalRange('over the last 2 days');
    expect(range?.start.toISOString()).toBe('2026-03-25T12:00:00.000Z');
    expect(range?.stop.toISOString()).toBe('2026-03-27T12:00:00.000Z');
  });

  it('formats and parses numeric historical values', () => {
    expect(parseHistoricalNumericValue('42.5')).toBe(42.5);
    expect(parseHistoricalNumericValue('not-a-number')).toBeNull();
    expect(formatAggregateNumber(1234.567)).toBe('1,234.57');
    expect(formatSignedAggregateNumber(-12)).toBe('-12');
  });

  it('detects historical query timeouts', () => {
    expect(isHistoricalQueryTimeout(new Error('request timed out'))).toBe(true);
    expect(isHistoricalQueryTimeout(new Error('different error'))).toBe(false);
  });
});
