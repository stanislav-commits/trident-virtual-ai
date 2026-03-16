import { ChatDocumentationCitationService } from './chat-documentation-citation.service';
import { ChatDocumentationQueryService } from './chat-documentation-query.service';

describe('ChatDocumentationCitationService', () => {
  const queryService = new ChatDocumentationQueryService();
  const service = new ChatDocumentationCitationService(queryService);

  it('keeps sources separate when they contain materially different facts for the same subject', () => {
    const citations = [
      {
        sourceTitle: 'Engine Manual.pdf',
        snippet:
          'Port generator engine oil change every 250 hours. Use SAE 15W-40.',
        score: 0.9,
      },
      {
        sourceTitle: 'Service Manual.pdf',
        snippet:
          'Port generator engine oil change every 500 hours. Use SAE 10W-40.',
        score: 0.88,
      },
    ];

    const prepared = service.prepareCitationsForAnswer(
      'port generator engine oil change',
      'How often should we change engine oil in the port generator?',
      citations,
    );

    expect(prepared.compareBySource).toBe(true);
    expect(prepared.sourceComparisonTitles).toContain('Engine Manual.pdf');
    expect(prepared.sourceComparisonTitles).toContain('Service Manual.pdf');
    expect(prepared.citations).toHaveLength(2);
  });

  it('prefers the exact source when another source is only approximate', () => {
    const citations = [
      {
        sourceTitle: 'Engine Manual.pdf',
        snippet:
          'Port generator engine oil: SAE 15W-40. Capacity 10 L.',
        score: 0.95,
      },
      {
        sourceTitle: 'Maintenance Tasks.pdf',
        snippet:
          'Port generator annual service inspect oil filter and record status.',
        score: 0.5,
      },
    ];

    const prepared = service.prepareCitationsForAnswer(
      'port generator engine oil',
      'What oil should we use for the port generator?',
      citations,
    );

    expect(prepared.compareBySource).toBe(false);
    expect(prepared.citations).toHaveLength(1);
    expect(prepared.citations[0].sourceTitle).toBe('Engine Manual.pdf');
  });

  it('prioritizes oil-relevant generator maintenance citations over unrelated generator rows', () => {
    const citations = [
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        snippet:
          'Reference row: Component name: PS ENGINE Task name: C MAIN GENERATOR 2000 HOURS SERVICE Reference ID: 1P49 Included work items: - REPLACE ALTERNATOR COOLANT PUMP - TEST OF THERMOSTATS - REPLACE ENGINE DRIVE BELT',
        score: 0.99,
      },
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        snippet:
          'Reference row: Component name: 0212 ENGINES Task name: PS ENGINE Reference ID: 1P297 MAIN GENERATOR 250 HOURS / 6 MONTHS MAINTENANCE Included work items: - REPLACE N1 CF - CHECK THE ENGINE / ALTERNATOR COOLING SYSTEM',
        score: 0.99,
      },
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        snippet:
          'Reference row: Component name: PS ENGINE Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE Reference ID: 1P47 Included work items: - TAKE OIL SAMPLE - TAKE COOLANT SAMPLE - REPLACE OIL AND FILTERS - REPLACE FUEL PREFILTER AND FILTER Spare parts: - Spare Name: Volvo Penta - Oil Filter Element',
        score: 0.99,
      },
    ];

    const refined = service.refineCitationsForIntent(
      'How do I change oil in the port generator?',
      'How do I change oil in the port generator?',
      citations,
    );

    expect(refined[0].snippet).toContain('Reference ID: 1P47');
    expect(refined[0].snippet).not.toContain('Reference ID: 1P49');
    expect(refined[0].snippet).not.toContain('Reference ID: 1P297');
  });

  it('keeps manual oil guidance alongside the matching schedule row for generator procedure queries', () => {
    const citations = [
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        snippet:
          'Reference row: Component name: PS ENGINE Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE Reference ID: 1P47 Included work items: - TAKE OIL SAMPLE - REPLACE OIL AND FILTERS - TAKE COOLANT SAMPLE',
        score: 0.98,
      },
      {
        sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
        snippet:
          'Lubrication System DIESEL ENGINE OIL. Do not fill up above the maximum oil level. Only use a recommended viscosity and quality of oil. Oil Filter/By-pass filter.',
        score: 0.87,
      },
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        snippet:
          'Reference row: Component name: SB ENGINE Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE Reference ID: 1S47 Included work items: - REPLACE OIL AND FILTERS',
        score: 0.99,
      },
    ];

    const refined = service.refineCitationsForIntent(
      'I need the oil change procedure for the port generator.',
      'I need the oil change procedure for the port generator.',
      citations,
    );

    expect(refined[0].snippet).toContain('Reference ID: 1P47');
    expect(
      refined.some((citation) =>
        citation.sourceTitle?.includes('Volvo Penta_operators manual'),
      ),
    ).toBe(true);
    expect(
      refined.some((citation) => citation.snippet?.includes('Reference ID: 1S47')),
    ).toBe(false);
  });
});
