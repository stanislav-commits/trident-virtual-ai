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

  it('prioritizes explicit DPA contact sheets over generic contact mentions for contact lookups', () => {
    const citations = [
      {
        sourceTitle: 'SEAWOLF X COMPLAINTS AND GRIEVANCE PROCEDURE 1.2 - Final.pdf',
        snippet:
          'The facts are to be forwarded to the Employer by email. The Employer may delegate further investigations to the Yacht Manager.',
        score: 0.3678,
      },
      {
        sourceTitle: '24.07.23 MMSI Confirmation Letter - TENDER.pdf',
        snippet:
          'Transport Malta will send the provided emergency contact details ashore to authorised entities. Tel: (356)21222203 Email: info.tm@transport.gov.mt',
        score: 0.2721,
      },
      {
        sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
        snippet:
          'JMs Yachting Company Contact Details Franc Jansen - Monaco franc@jmsyachting.com JMS Founder, Director & DPA (M) +33 612 639 648',
        score: 0.2732,
      },
      {
        sourceTitle: 'Seawolf X SOPEP.pdf',
        snippet:
          'The contact details of the vessel contracted Damage Stability Provider can be found in ANNEX 1.',
        score: 0.2653,
      },
    ];

    const refined = service.refineCitationsForIntent(
      'who vessel dpa contact details',
      'provide his contacts',
      citations,
    );
    const prepared = service.prepareCitationsForAnswer(
      'who vessel dpa contact details',
      'provide his contacts',
      refined,
    );

    expect(refined[0].sourceTitle).toBe('JMS Company Contact Details Jan 26.pdf');
    expect(prepared.compareBySource).toBe(false);
    expect(prepared.citations[0].sourceTitle).toBe(
      'JMS Company Contact Details Jan 26.pdf',
    );
    expect(
      prepared.citations.some((citation) =>
        /grievance|mmsi confirmation/i.test(citation.sourceTitle ?? ''),
      ),
    ).toBe(false);
  });

  it('keeps a wider citation window for contact lookups so explicit contact sheets are not trimmed out', () => {
    const citations = Array.from({ length: 20 }, (_, index) => ({
      sourceTitle: `Source ${index + 1}.pdf`,
      snippet:
        index === 9
          ? 'Franc Jansen - Monaco franc@jmsyachting.com DPA +33 612 639 648'
          : `Generic snippet ${index + 1}`,
      score: 1 - index * 0.01,
    }));

    expect(
      service.limitCitationsForLlm('provide his contacts', citations, false),
    ).toHaveLength(16);
  });

  it('prioritizes company contact sheets for role-based personnel directory queries', () => {
    const citations = [
      {
        sourceTitle: 'Fleet Safety Circular.pdf',
        snippet:
          'Managers must foster a professional and respectful environment across the fleet.',
        score: 0.98,
      },
      {
        sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
        snippet:
          'Zoe Bolt Falconer - The Netherlands Fleet Compliance Manager, DPA & CSO (M) +31 633 010 685 zoe@jmsyachting.com Tom Vannieuwenhuyse - Palma Fleet Manager DPA/CSO (M) +34 666 884 852 tom@jmsyachting.com',
        score: 0.66,
      },
    ];

    const refined = service.refineCitationsForIntent(
      'list all managers',
      'list all managers',
      citations,
    );

    expect(refined[0].sourceTitle).toBe('JMS Company Contact Details Jan 26.pdf');
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

  it('prefers item-specific impeller spare evidence over generic same-asset spare rows', () => {
    const citations = [
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        snippet:
          'Reference row: Component name: PS ENGINE Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE Reference ID: 1P47 Spare parts: - Spare Name: Volvo Penta Engine Oil 15W-40 Quantity: 2 Location: Bilges Steering Room - Spare Name: Oil Filter Element Quantity: 4 Location: Box 21 Volvo Penta Oil Filters',
        score: 0.99,
      },
      {
        sourceTitle: 'Recommended Mase Parts.pdf',
        snippet:
          'List of recommended spare Mase parts. Sea water pump impeller code 913722. Quantity: 1. Location: Box 25 Volvo Penta Spares.',
        score: 0.74,
      },
    ];

    const refined = service.refineCitationsForIntent(
      'Where are the impeller spares for the port generator stored?',
      'Where are the impeller spares for the port generator stored?',
      citations,
    );

    expect(refined[0].sourceTitle).toBe('Recommended Mase Parts.pdf');
    expect(refined[0].snippet).toContain('impeller');
    expect(
      refined.some((citation) => /Oil Filter Element|Engine Oil/i.test(citation.snippet ?? '')),
    ).toBe(false);
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

  it('prefers explicit future-dated certificate snippets over registry certificates for broad expiry questions', () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 2, 28));
    const citations = [
      {
        sourceTitle: 'CoR Private.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet:
          'CERTIFICATE OF MALTA REGISTRY. Name of Ship SEAWOLF X. Official and IMO No.',
        score: 0.99,
      },
      {
        sourceTitle:
          '26.01.13 SEAWOLF X Renewal Certificate of Reg. (exp 27.01.15).pdf',
        sourceCategory: 'CERTIFICATES',
        snippet:
          'CERTIFICATE OF MALTA REGISTRY. Renewing Certificate dated 06 January 2025.',
        score: 0.98,
      },
      {
        sourceTitle: 'Fire Suppression Survey.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet:
          'Fixed fire suppression system survey. Certificate valid until 14 August 2026.',
        score: 0.82,
      },
      {
        sourceTitle:
          'VSS001990 - Viking PS37891054000 Fireman suite complete MCA SO_SOLAS Certificato Mod. B.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet: 'Expiration date: 29 July 2024.',
        score: 0.85,
      },
    ];

    try {
      const refined = service.refineCitationsForIntent(
        'Which certificates will expire soon?',
        'Which certificates will expire soon?',
        citations,
      );

      expect(refined[0].sourceTitle).toBe('Fire Suppression Survey.pdf');
      expect(
        refined.some((citation) => citation.sourceTitle === 'CoR Private.pdf'),
      ).toBe(false);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps hyphenated month expiry certificates for broad expiry answers', () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 2, 28));
    const citations = [
      {
        sourceTitle: 'CoR Private.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet:
          'CERTIFICATE OF MALTA REGISTRY. Name of Ship SEAWOLF X. Official and IMO No.',
        score: 0.99,
      },
      {
        sourceTitle: "Selmar Type Approval Certificate.pdf",
        sourceCategory: 'CERTIFICATES',
        snippet:
          'THIS CERTIFICATE IS ISSUED IN COMPLIANCE WITH MODULE D. ISSUE DATE: 10-feb-2022 EXPIRATION DATE: 22-dec-2026.',
        score: 0.81,
      },
    ];

    try {
      const prepared = service.prepareCitationsForAnswer(
        'Which certificates will expire soon?',
        'Which certificates will expire soon?',
        citations,
      );

      expect(prepared.citations).toEqual([
        expect.objectContaining({
          sourceTitle: 'Selmar Type Approval Certificate.pdf',
        }),
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('filters survey guideline and inspection report support docs out of broad expiry answers', () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2026, 2, 28));
    const citations = [
      {
        sourceTitle: 'Seawolf X - CY Survey Guidelines.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet:
          'Buoyant Smoke Signals (Expiry Date:05/28). EPIRB(Battery Exp:11/34).',
        score: 0.98,
      },
      {
        sourceTitle: 'MLC 2006 - Inspection report - for vessel under 500 GT Seawolf X.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet:
          'Statement of Compliance. Valid until: 26th October 2025.',
        score: 0.97,
      },
      {
        sourceTitle: 'Selmar Type Approval Certificate.pdf',
        sourceCategory: 'CERTIFICATES',
        snippet:
          'THIS CERTIFICATE IS ISSUED IN COMPLIANCE WITH MODULE D. EXPIRATION DATE: 22-dec-2026.',
        score: 0.79,
      },
    ];

    try {
      const prepared = service.prepareCitationsForAnswer(
        'Which certificates will expire soon?',
        'Which certificates will expire soon?',
        citations,
      );

      expect(prepared.citations).toEqual([
        expect.objectContaining({
          sourceTitle: 'Selmar Type Approval Certificate.pdf',
        }),
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('falls back to embedded approval expiry evidence when no standalone certificate expiry is available', () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.UTC(2024, 2, 28));
    const citations = [
      {
        sourceTitle: 'Gas Detector manualRev.1.11.pdf',
        sourceCategory: 'MANUALS',
        snippet: 'This certificate will expire on 12 Dec 2022.',
        score: 0.99,
      },
      {
        sourceTitle:
          "Selmar_2023F29001_Blue Sea 4000 Plus_User's Guide.pdf",
        sourceCategory: 'MANUALS',
        snippet:
          'Product Design Assessment (PDA) Expiry Date 27-OCT-2025. Manufacturing Assessment (MA) Expiry Date 28-OCT-2025.',
        score: 0.97,
      },
    ];

    try {
      const prepared = service.prepareCitationsForAnswer(
        'Which certificates will expire soon?',
        'Which certificates will expire soon?',
        citations,
      );

      expect(prepared.citations).toEqual([
        expect.objectContaining({
          sourceTitle:
            "Selmar_2023F29001_Blue Sea 4000 Plus_User's Guide.pdf",
        }),
      ]);
    } finally {
      nowSpy.mockRestore();
    }
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
