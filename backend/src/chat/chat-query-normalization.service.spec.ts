import { ChatQueryNormalizationService } from './chat-query-normalization.service';

describe('ChatQueryNormalizationService', () => {
  const service = new ChatQueryNormalizationService();

  it('normalizes equivalent historical tank-level phrasings to the same material query meaning', () => {
    const queries = [
      'what was the tank level 2026-03-25?',
      'tank level on 2026-03-25',
      'what did the tank read on 25 March 2026?',
    ].map((userQuery) => service.normalizeTurn({ userQuery }));

    for (const normalized of queries) {
      expect(normalized.timeIntent.kind).toBe('historical_point');
      expect(normalized.timeIntent.absoluteDate).toBe('2026-03-25');
      expect(normalized.sourceHints).toContain('TELEMETRY');
      expect(normalized.subject).toEqual(expect.stringContaining('tank'));
    }

    expect(queries[0].operation).toBe(queries[1].operation);
    expect(queries[1].operation).toBe(queries[2].operation);
  });

  it('detects historical fuel-event language as a first-class event query', () => {
    const bunkering = service.normalizeTurn({
      userQuery: 'when was last bunkering?',
    });
    const increase = service.normalizeTurn({
      userQuery: 'check it based on fuel last increase',
    });

    expect(bunkering.operation).toBe('event');
    expect(bunkering.timeIntent.kind).toBe('historical_event');
    expect(bunkering.timeIntent.eventType).toBe('bunkering');
    expect(increase.operation).toBe('event');
    expect(increase.timeIntent.kind).toBe('historical_event');
    expect(increase.timeIntent.eventType).toBe('fuel_increase');
  });
});
