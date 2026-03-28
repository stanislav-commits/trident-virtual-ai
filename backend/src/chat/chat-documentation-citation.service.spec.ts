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

  it('prioritizes history procedures over manuals for next-due questions', () => {
    const citations = [
      {
        sourceTitle: 'Volvo Penta D13 Manual.pdf',
        sourceCategory: 'MANUALS',
        snippet: 'Oil change interval: every 500 running hours.',
        score: 0.97,
      },
      {
        sourceTitle: 'PMS Export.pdf',
        sourceCategory: 'HISTORY_PROCEDURES',
        snippet:
          'Task name: Starboard engine oil change. Last due: 4000 hours. Next due: 4500 hours.',
        score: 0.9,
      },
    ];

    const refined = service.refineCitationsForIntent(
      'When should I change the oil in the right engine?',
      'When should I change the oil in the right engine?',
      citations,
    );

    expect(refined[0].sourceCategory).toBe('HISTORY_PROCEDURES');
  });

  it('prioritizes certificate evidence over manuals for expiry questions', () => {
    const citations = [
      {
        sourceTitle: 'Fire Suppression Manual.pdf',
        sourceCategory: 'MANUALS',
        snippet: 'Inspect the suppression system during scheduled maintenance.',
        score: 0.98,
      },
      {
        sourceTitle: 'Fire Suppression Survey.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet: 'Certificate valid until 14 August 2026.',
        score: 0.88,
      },
    ];

    const refined = service.refineCitationsForIntent(
      'When does the fire suppression system certificate expire?',
      'When does the fire suppression system certificate expire?',
      citations,
    );

    expect(refined[0].sourceCategory).toBe('CERTIFICATES');
  });

  it('prefers the fire suppression survey over unrelated extinguisher certificates for suppression expiry questions', () => {
    const citations = [
      {
        sourceTitle: 'Inventory List.pdf',
        sourceCategory: 'INVENTORY',
        snippet:
          'Items list with miscellaneous expiry dates for onboard equipment.',
        score: 0.99,
      },
      {
        sourceTitle:
          'VSS001980 - VSS Fire Extinguisher Powder Kg 6_SOLAS Certificato Mod. B.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet:
          'This certificate remains valid unless cancelled or revoked. First issue 08/01/2021. Expiry 07/01/2026.',
        score: 0.98,
      },
      {
        sourceTitle: 'Fire Suppression Survey.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet:
          'Fixed fire suppression system survey. Certificate valid until 14 August 2026.',
        score: 0.84,
      },
    ];

    const refined = service.refineCitationsForIntent(
      'What is the expiry date of the fire suppression certificate?',
      'What is the expiry date of the fire suppression certificate?',
      citations,
    );

    expect(refined[0].sourceTitle).toBe('Fire Suppression Survey.pdf');
    expect(
      refined.some((citation) => /Fire Extinguisher/i.test(citation.sourceTitle ?? '')),
    ).toBe(false);
  });

  it('prioritizes regulations over certificates for compliance questions', () => {
    const citations = [
      {
        sourceTitle: 'OWS Certificate.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet: '15 PPM monitor calibrated and valid until 2028.',
        score: 0.94,
      },
      {
        sourceTitle: 'MARPOL Annex I.pdf',
        sourceCategory: 'REGULATION',
        snippet:
          'Discharge of oily water exceeding 15 ppm into the sea is prohibited.',
        score: 0.82,
      },
    ];

    const refined = service.refineCitationsForIntent(
      'What are our obligations for bilge water discharge under MARPOL?',
      'What are our obligations for bilge water discharge under MARPOL?',
      citations,
    );

    expect(refined[0].sourceCategory).toBe('REGULATION');
  });

  it('filters unrelated control-system citations out of troubleshooting answers when a matching generator coolant citation exists', () => {
    const citations = [
      {
        sourceTitle: 'AP70-MK2_OM_EN_988-12375-001_w.pdf',
        sourceCategory: 'MANUALS',
        snippet:
          'High internal temp. Internal temperature >75 C. Check battery, charger condition, plotter and cable connections.',
        score: 0.99,
      },
      {
        sourceTitle: 'Volvo Generator Manual.pdf',
        sourceCategory: 'MANUALS',
        snippet:
          'Coolant Temperature Possible cause: The coolant temperature is too high. Corrective Action: Check the coolant level. Check the seawater filter. Check the impeller in the seawater pump.',
        score: 0.78,
      },
    ];

    const refined = service.refineCitationsForIntent(
      'The port generator has a high coolant temperature alarm, what checks should I do first?',
      'The port generator has a high coolant temperature alarm, what checks should I do first?',
      citations,
    );

    expect(refined[0].sourceTitle).toBe('Volvo Generator Manual.pdf');
    expect(
      refined.some((citation) => /AP70-MK2/i.test(citation.sourceTitle ?? '')),
    ).toBe(false);
  });

  it('hard-filters explicit source requests by source title instead of matching nearby snippet text', () => {
    const citations = [
      {
        sourceTitle: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
        snippet:
          'Use genuine Volvo oil, filters and components. Refer to the Volvo manual for additional maintenance.',
        score: 0.96,
      },
      {
        sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
        snippet: 'Oil change interval: 500 hours or 12 months.',
        score: 0.88,
      },
    ];

    const refined = service.refineCitationsForIntent(
      'What is the oil change interval in the Volvo manual?',
      'What is the oil change interval in the Volvo manual?',
      citations,
    );

    expect(refined).toHaveLength(1);
    expect(refined[0].sourceTitle).toContain('Volvo Penta_operators manual');
  });
});
