import { ChatQueryNormalizationService } from './chat-query-normalization.service';

describe('ChatQueryNormalizationService', () => {
  const service = new ChatQueryNormalizationService();

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-31T00:00:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

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

  it('detects change-over-time telemetry questions as trend operations instead of sums', () => {
    const trend = service.normalizeTurn({
      userQuery: 'explain me total fuel trend for last 7 days',
    });
    const difference = service.normalizeTurn({
      userQuery: 'what was the difference in total fuel over the last 7 days?',
    });
    const abrupt = service.normalizeTurn({
      userQuery: 'were there any sharp jumps in bilge level over the last week?',
    });

    expect(trend.operation).toBe('trend');
    expect(trend.timeIntent.kind).toBe('historical_range');
    expect(trend.sourceHints).toContain('TELEMETRY');
    expect(difference.operation).toBe('trend');
    expect(difference.timeIntent.kind).toBe('historical_range');
    expect(difference.sourceHints).toContain('TELEMETRY');
    expect(abrupt.operation).toBe('trend');
    expect(abrupt.timeIntent.kind).toBe('historical_range');
    expect(abrupt.sourceHints).toContain('TELEMETRY');
  });

  it('attaches a time-only reply to the active historical clarification state', () => {
    const normalized = service.normalizeTurn({
      userQuery: '12:00 UTC',
      messageHistory: [
        {
          role: 'user',
          content: 'what was the tank level 2026-03-25?',
        },
        {
          role: 'assistant',
          content: 'Please specify the exact time for this historical telemetry lookup.',
          ragflowContext: {
            awaitingClarification: true,
            answerRoute: 'clarification',
            clarificationReason: 'historical_telemetry_query',
            pendingClarificationQuery: 'what was the tank level 2026-03-25?',
            normalizedQuery: {
              rawQuery: 'what was the tank level 2026-03-25?',
              normalizedQuery: 'what was the tank level 2026-03-25?',
              retrievalQuery: 'what was the tank level 2026-03-25?',
              effectiveQuery: 'what was the tank level 2026-03-25?',
              followUpMode: 'standalone',
              subject: 'tank level',
              operation: 'lookup',
              timeIntent: {
                kind: 'historical_point',
                expression: '2026-03-25',
                absoluteDate: '2026-03-25',
              },
              sourceHints: ['TELEMETRY', 'HISTORY'],
              isClarificationReply: false,
              ambiguityFlags: ['missing_explicit_time'],
            },
          },
        },
      ],
    });

    expect(normalized.followUpMode).toBe('clarification_reply');
    expect(normalized.retrievalQuery).toContain('at 12:00 UTC');
    expect(normalized.timeIntent.kind).toBe('historical_point');
    expect(normalized.ambiguityFlags).not.toContain('missing_explicit_time');
    expect(normalized.clarificationState).toEqual(
      expect.objectContaining({
        clarificationDomain: 'historical_telemetry',
        pendingQuery: 'what was the tank level 2026-03-25?',
        requiredFields: ['time_of_day'],
        resolvedFields: expect.objectContaining({
          date: '2026-03-25',
          time_of_day: '12:00 UTC',
        }),
      }),
    );
  });

  it('keeps DPA contact follow-ups on the previous resolved subject after clarification-state refactoring', () => {
    const normalized = service.normalizeTurn({
      userQuery: 'provide contacts',
      messageHistory: [
        {
          role: 'user',
          content: "who is vessel's dpa?",
        },
        {
          role: 'assistant',
          content: 'The vessel DPA is John Doe.',
          ragflowContext: {
            answerRoute: 'deterministic_contact',
            resolvedSubjectQuery: 'dpa contact details',
          },
        },
      ],
    });

    expect(normalized.followUpMode).toBe('follow_up');
    expect(normalized.retrievalQuery).toBe('dpa contact details');
    expect(normalized.isClarificationReply).toBe(false);
  });

  it('keeps bare contact shorthand and other-one follow-ups on the prior DPA subject', () => {
    const contacts = service.normalizeTurn({
      userQuery: 'contacts',
      messageHistory: [
        {
          role: 'user',
          content: "who is vessel's dpa?",
        },
        {
          role: 'assistant',
          content: 'The vessel DPA is JMS.',
          ragflowContext: {
            answerRoute: 'llm_generation',
            resolvedSubjectQuery: "who is vessel's dpa?",
          },
        },
      ],
    });

    expect(contacts.followUpMode).toBe('follow_up');
    expect(contacts.retrievalQuery).toBe('vessel dpa contact details');

    const otherOne = service.normalizeTurn({
      userQuery: 'what about the other one?',
      messageHistory: [
        {
          role: 'user',
          content: "who is vessel's dpa?",
        },
        {
          role: 'assistant',
          content: 'I found multiple matching DPA contacts.',
          ragflowContext: {
            answerRoute: 'deterministic_contact',
            resolvedSubjectQuery: 'vessel dpa contact email',
          },
        },
      ],
    });

    expect(otherOne.followUpMode).toBe('follow_up');
    expect(otherOne.retrievalQuery).toBe(
      'vessel dpa contact email what about the other one?',
    );
  });

  it('prefers explicit ordinal dates over duplicated relative fragments in historical continuations', () => {
    const normalized = service.normalizeTurn({
      userQuery: '5 days ago, on 25th of March',
      messageHistory: [
        {
          role: 'user',
          content: 'how many total fuel in tanks 5 days ago?',
        },
        {
          role: 'assistant',
          content: 'Here is the historical fuel answer.',
          ragflowContext: {
            answerRoute: 'historical_telemetry',
            resolvedSubjectQuery: 'how many total fuel in tanks 5 days ago',
          },
        },
      ],
    });

    expect(normalized.followUpMode).toBe('follow_up');
    expect(normalized.retrievalQuery).toBe(
      'how many total fuel in tanks on 2026-03-25',
    );
    expect(normalized.timeIntent.kind).toBe('historical_point');
    expect(normalized.timeIntent.absoluteDate).toBe('2026-03-25');
  });

  it('keeps telemetry source override follow-ups attached to the previous subject', () => {
    const normalized = service.normalizeTurn({
      userQuery: 'based on telemetry',
      messageHistory: [
        {
          role: 'user',
          content: 'when and which was the bilge alarm last activated?',
        },
        {
          role: 'assistant',
          content: 'I could not confirm that from the documentation.',
          ragflowContext: {
            answerRoute: 'llm_generation',
            resolvedSubjectQuery:
              'when and which was the bilge alarm last activated?',
          },
        },
      ],
    });

    expect(normalized.followUpMode).toBe('follow_up');
    expect(normalized.retrievalQuery).toContain('bilge alarm');
    expect(normalized.retrievalQuery).toContain('last activated');
    expect(normalized.retrievalQuery).toContain('from telemetry');
    expect(normalized.sourceHints).toContain('TELEMETRY');
    expect(normalized.timeIntent.kind).toBe('none');
  });

  it('keeps completeness follow-ups attached to the previous telemetry subject', () => {
    const normalized = service.normalizeTurn({
      userQuery: 'you missed a lot of bilge alarms, write all',
      messageHistory: [
        {
          role: 'user',
          content: 'list all available bilge alarm metrics',
        },
        {
          role: 'assistant',
          content: 'Here are some bilge alarm metrics.',
          ragflowContext: {
            answerRoute: 'deterministic_telemetry',
            resolvedSubjectQuery: 'list all available bilge alarm metrics',
          },
        },
      ],
    });

    expect(normalized.followUpMode).toBe('follow_up');
    expect(normalized.retrievalQuery).toContain('bilge alarm metrics');
    expect(normalized.retrievalQuery).toContain('show all available');
    expect(normalized.sourceHints).toContain('TELEMETRY');
  });

  it('preserves historical time anchors for completeness follow-ups after telemetry aggregates', () => {
    const normalized = service.normalizeTurn({
      userQuery: 'you missed 3 tanks',
      messageHistory: [
        {
          role: 'user',
          content: 'how much total fuel was 5 days ago?',
        },
        {
          role: 'assistant',
          content: 'At 2026-03-28 09:47 UTC, the total was ...',
          ragflowContext: {
            answerRoute: 'historical_telemetry',
            resolvedSubjectQuery: 'how much total fuel was 5 days ago?',
          },
        },
      ],
    });

    expect(normalized.followUpMode).toBe('follow_up');
    expect(normalized.retrievalQuery).toContain('5 days ago');
    expect(normalized.retrievalQuery).toContain('show all available');
    expect(normalized.timeIntent.kind).toBe('historical_point');
    expect(normalized.timeIntent.relativeAmount).toBe(5);
    expect(normalized.timeIntent.relativeUnit).toBe('day');
    expect(normalized.sourceHints).toContain('TELEMETRY');
    expect(normalized.sourceHints).toContain('HISTORY');
  });

  it('lets an explicit current-time follow-up override the previous historical anchor', () => {
    const normalized = service.normalizeTurn({
      userQuery: 'what about now?',
      messageHistory: [
        {
          role: 'user',
          content: 'how much total fuel was 5 days ago?',
        },
        {
          role: 'assistant',
          content: 'At 2026-03-28 09:47 UTC, the total was ...',
          ragflowContext: {
            answerRoute: 'historical_telemetry',
            resolvedSubjectQuery: 'how much total fuel was 5 days ago?',
          },
        },
      ],
    });

    expect(normalized.followUpMode).toBe('follow_up');
    expect(normalized.retrievalQuery).toContain('fuel');
    expect(normalized.retrievalQuery).toContain('tanks');
    expect(normalized.retrievalQuery).toContain('right now');
    expect(normalized.retrievalQuery).not.toContain('show all available');
    expect(normalized.timeIntent.kind).toBe('current');
    expect(normalized.sourceHints).toContain('TELEMETRY');
  });

  it('does not leak a previous historical time intent into a current coordinate question', () => {
    const normalized = service.normalizeTurn({
      userQuery: 'what lon and lat is now?',
      messageHistory: [
        {
          role: 'user',
          content: 'what lon and lat were 5 days ago?',
        },
        {
          role: 'assistant',
          content: 'At 2026-03-27 10:05 UTC, the vessel position was ...',
          ragflowContext: {
            answerRoute: 'historical_telemetry',
            resolvedSubjectQuery: 'what lon and lat were 5 days ago?',
          },
        },
      ],
    });

    expect(normalized.followUpMode).toBe('standalone');
    expect(normalized.operation).toBe('position');
    expect(normalized.timeIntent.kind).toBe('current');
    expect(normalized.sourceHints).toContain('TELEMETRY');
  });
});
