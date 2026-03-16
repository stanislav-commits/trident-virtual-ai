import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatReferenceExtractionService } from './chat-reference-extraction.service';
import { ChatCitation } from './chat.types';

describe('ChatReferenceExtractionService', () => {
  const service = new ChatReferenceExtractionService(
    new ChatDocumentationQueryService(),
  );

  it('focuses the table block that actually contains the requested reference', () => {
    const snippet = `<table><caption> M/Y Seawolf X - Maintenance Tasks</caption>
<tr><th  >PGroup name Spare Name SPAREPARTSKITFORACB332 L-23-09457 0212 ENGINES</th><th  >Component name Quantity 11 SB ENGINE</th><th  >Task name ReferenceID [Location BOX11FRESHWATER,BOX04PUMPS B MAIN GENERATOR 1000 HOURS/ 1P55</th></tr>
</table>
<table>
<tr><th  >0212 ENGINES</th><th  >PS ENGINE</th><th  >EMAINGENERATOR 3000 HOURS</th></tr>
<tr><td></td><td></td><td  >SERVICE</td></tr>
<tr><th></th><th></th><th  >1P50</th><th  >Chief Engineer</th><th  >4 Years / 3000 MAIN</th></tr>
<tr><td></td><td></td><td></td><td></td><td  >GENSETPS</td></tr>
<tr><th></th><th></th><th></th><th></th><th  >15.08.2024/0</th><th  >15.08.2028/ 3000</th><th  >EUR</th></tr>
</table>`;

    const focused = service.focusReferenceSnippet(snippet, '1p50');

    expect(focused).toContain('1P50');
    expect(focused).not.toContain('1P55');
    expect(focused).toContain('4 Years / 3000 MAIN');
  });

  it('combines a reference row with continuation chunks containing spare parts', () => {
    const snippets = [
      `<tr><th  >CHECKVALVE CLEARANCES CHECK ALTERNATOR COOLANT PUMP 0212 ENGINES</th><th  >PS ENGINE</th><th  >BIANNUAL SERVICE B MAIN GENERATOR 1000 HOURS/ 1P48 BIANNUAL SERVICE</th><th  >Chief Engineer</th><th  >1750 GENSET SB 2 Years /  07.07.2025 / 1000 MAIN GENSETPS</th><th  >2750</th><th></th></tr>
<table>
<tr><th  >0212 ENGINES</th><th  >PS ENGINE</th><th  >EMAINGENERATOR 3000 HOURS</th><th></th><th></th><th></th><th></th></tr>
<tr><td></td><td></td><td  >SERVICE</td><td></td><td></td><td></td><td></td></tr>
<tr><th></th><th></th><th  >1P50</th><th  >Chief Engineer</th><th  >4 Years / 3000 MAIN</th><th></th><th></th></tr>
<tr><td></td><td></td><td></td><td></td><td  >GENSETPS</td><td></td><td></td></tr>
<tr><th></th><th></th><th></th><th></th><th  >15.08.2024/0</th><th  >15.08.2028/ 3000</th><th  >EUR</th></tr>
</table>`,
      `<tr><th  >REPLACE ELASTIC COUPLING BETWEEN ENGINE AND ALTERNATOR Spare Name Coolant VCS Concentrated Yellow2</th><th></th></tr>
<tr><td  >20Lt</td><td></td></tr>
<tr><th  >REPLACEWEARKITINSEAWATERPUIMP</th><th></th></tr>
<tr><th  >Spare Name VolvoPenta -WearKit(Sw.Pump)1</th><th></th></tr>
<table>
<tr><th  >[Quantity</th><th  >[Location</th><th  >Manufacturer Part#</th><th  >Supplier Part#</th></tr>
<tr><th></th><th  >BOX25VOLVOPENTASPARES</th><th  >23660712</th><th  >SYS00359837</th></tr>
</table>`,
    ];

    const combined = service.buildReferenceCombinedSnippet('1p50', snippets);

    expect(combined).toContain('Reference ID: 1P50');
    expect(combined).toContain('REPLACE WEAR KIT IN SEA WATER PUMP');
    expect(combined).toContain('VOLVO PENTA -WEAR KIT');
    expect(combined).toContain('BOX 25 VOLVO PENTA SPARES');
    expect(combined).toContain('23660712');
    expect(combined).toContain('SYS00359837');
    expect(combined).not.toContain('BILGEUNDERBEACHCLUB');
    expect(combined).not.toContain('Coolant VCS Concentrated Yellow');
  });

  it('builds an exact resolved subject query from a clear maintenance row citation', () => {
    const citations: ChatCitation[] = [
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        snippet: `Component name: PS ENGINE
Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE
Reference ID: 1P47
Responsible: Chief Engineer
Interval: 1 Years /500 MAIN GENSET PS
Last due: 07.07.2025 / 1534
Next due: 07.07.2026 / 2034`,
      },
      {
        sourceTitle: 'Volvo Penta_operators manual_47710211.pdf',
        snippet:
          'Check oil level. Tighten all external threaded fasteners. Adjust shift control linkage.',
      },
    ];

    const resolved = service.buildResolvedMaintenanceSubjectQuery(
      'When is the next maintenance on the port generator due?',
      'When is the next maintenance on the port generator due?',
      citations,
    );

    expect(resolved).toContain('Reference ID 1P47');
    expect(resolved).toContain('PS ENGINE');
    expect(resolved).toContain('A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE');
  });

  it('prefers the first explicit matching maintenance row over nearby conflicting rows', () => {
    const citations: ChatCitation[] = [
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        score: 0.98,
        snippet: `Component name: PS ENGINE
Task name: A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE
Reference ID: 1P47
Responsible: Chief Engineer
Interval: 1 Years /500 MAIN GENSET PS
Last due: 07.07.2025 / 1534
Next due: 07.07.2026 / 2034`,
      },
      {
        sourceTitle: 'M_Y Seawolf X - Maintenance Tasks.pdf',
        score: 0.82,
        snippet: `Component name: PS ENGINE
Task name: C MAIN GENERATOR 2000 HOURS SERVICE
Reference ID: 1P49
Responsible: Chief Engineer
Interval: 4 Years / 2000 MAIN GENSET PS
Last due: 07.07.2025 / 1534
Next due: 07.07.2029 / 3534`,
      },
    ];

    const resolved = service.buildResolvedMaintenanceSubjectQuery(
      'When is the next maintenance on the port generator due?',
      'When is the next maintenance on the port generator due?',
      citations,
    );

    expect(resolved).toContain('Reference ID 1P47');
    expect(resolved).not.toContain('Reference ID 1P49');
  });

  it('keeps long maintenance task and spare-parts continuations for an exact reference row', () => {
    const snippet = `<table><caption> M/Y Seawolf X - Maintenance Tasks</caption>
<tr><td>0212 ENGINES</td><td>PS ENGINE</td><td>A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE</td><td>1P47</td><td>Chief Engineer</td><td>1 Years / 500 MAIN GENSET PS</td><td>07.07.2025 / 1534</td><td>07.07.2026 / 2034</td><td>EUR</td></tr>
<tr><td>CHECK SOFTWARE STATUS</td></tr>
<tr><td>TAKE OIL SAMPLE</td></tr>
<tr><td>TAKE COOLANT SAMPLE</td></tr>
<tr><td>REPLACE OIL AND FILTERS</td></tr>
<tr><td>CHECK COOLANT LEVEL AND ANTI FREEZE MIXTURE</td></tr>
<tr><td>CHECK / REPLACE DRIVE BELTS</td></tr>
<tr><td>REPLACE FUEL PREFILTER AND FILTER</td></tr>
<tr><td>CLEAN SEAWATER STRAINER</td></tr>
<tr><td>INSPECT AIR FILTER</td></tr>
<tr><td>ENGINE SPEED CONTROL AND ADJUSTMENT</td></tr>
</table>
<table>
<tr><td>Spare Name</td><td>Quantity</td><td>Location</td><td>Manufacturer Part#</td><td>Supplier Part#</td></tr>
<tr><td>Volvo Penta Engine Oil 15W-40</td><td>2</td><td>BILGE SB STEERING ROOM, BILGE UNDER BEACH CLUB</td><td></td><td>MMVLV23909461</td></tr>
<tr><td>ZINC ANODE</td><td>2</td><td>BOX 26 VOLVO PENTA SPARES</td><td>913728</td><td></td></tr>
<tr><td>Volvo Penta - Oil Bypass Filter</td><td>1</td><td>BOX 23 VOLVO PENTA OIL FILTERS, BOX 22 VOLVO PENTA OIL FILTERS</td><td>21707132</td><td>SYS00029939</td></tr>
<tr><td>Volvo Penta - Oil Filter Element</td><td>2</td><td>BOX 21 VOLVO PENTA OIL FILTERS, BOX 22 VOLVO PENTA OIL FILTERS</td><td>23658092</td><td>SYS00330068</td></tr>
<tr><td>Volvo Penta - Impeller Kit</td><td>1</td><td>BOX 25 VOLVO PENTA SPARES</td><td>3830459</td><td>SYS00092226</td></tr>
</table>`;

    const extracted = service.extractGeneratorScheduleSnippet(snippet, 'port');

    expect(extracted).toContain('Reference ID: 1P47');
    expect(extracted).toContain('CHECK SOFTWARE STATUS');
    expect(extracted).toContain('ENGINE SPEED CONTROL AND ADJUST');
    expect(extracted).toContain('Volvo Penta - Impeller Kit');
    expect(extracted).toContain('SYS00092226');
  });

  it('repairs OCR-shifted spare-part rows without turning box numbers or task lines into fake quantities', () => {
    const snippet = `<table><caption> M/Y Seawolf X - Maintenance Tasks</caption>
<tr><td>0212 ENGINES</td><td>PS ENGINE</td><td>A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE</td><td>1P47</td><td>Chief Engineer</td><td>1 Years / 500 MAIN GENSET PS</td><td>07.07.2025 / 1534</td><td>07.07.2026 / 2034</td><td>EUR</td></tr>
<tr><td>INSPECT / REPLACE ANODES 2X ALTERNATOR COOLER, 2X ENGINE COOLER, 2X EXHAUST</td></tr>
</table>
<table>
<tr><td>Spare Name</td><td>Quantity</td><td>Location</td><td>Manufacturer Part#</td><td>Supplier Part#</td></tr>
<tr><td>Volvo Penta - Oil Bypass Filter</td><td></td><td>BOX23VOLVOPENTAOILFILTERS,BOX22VOLVOPENTAOILFILTERS</td><td>21707132</td><td>SYS00029939</td></tr>
<tr><td>Volvo Penta - Fuel Filter</td><td></td><td>BOX24VOLVOPENTAFUELFILTER</td><td>22377272</td><td>SYS00073554</td></tr>
<tr><td>AUXILLIARYWATERPUMP</td><td></td><td>BOX26VOLVOPENTASPARES</td><td>71793</td><td></td></tr>
</table>`;

    const extracted = service.extractGeneratorScheduleSnippet(snippet, 'port');

    expect(extracted).toContain('Volvo Penta - Oil Bypass Filter');
    expect(extracted).toContain('Location: BOX 23 VOLVO PENTA OIL FILTERS,BOX 22 VOLVO PENTA OIL FILTERS');
    expect(extracted).not.toContain('Spare Name: INSPECT / REPLACE ANODES');
    expect(extracted).not.toContain('Quantity: 23');
    expect(extracted).toContain('AUXILLIARYWATER PUMP');
    expect(extracted).toContain('Manufacturer Part#: 71793');
  });

  it('moves numeric pseudo-locations back into quantity when OCR shifts box storage into the part-number column', () => {
    const snippet = `<table><caption> M/Y Seawolf X - Maintenance Tasks</caption>
<tr><td>0212 ENGINES</td><td>PS ENGINE</td><td>A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE</td><td>1P47</td><td>Chief Engineer</td><td>1 Years / 500 MAIN GENSET PS</td><td>07.07.2025 / 1534</td><td>07.07.2026 / 2034</td><td>EUR</td></tr>
</table>
<table>
<tr><td>Spare Name</td><td>Quantity</td><td>Location</td><td>Manufacturer Part#</td><td>Supplier Part#</td></tr>
<tr><td>ZINCANODE</td><td></td><td>2</td><td>BOX26VOLVOPENTASPARES</td><td>913728</td></tr>
<tr><td>ALUMINIUMSACRIFICAL</td><td></td><td>2</td><td>BOX45EXHAUST</td><td>805001A</td></tr>
<tr><td>INSPECT / REPLACE ANODES</td><td>2</td><td>X ALTERNATOR COOLER, 2X ENGINE COOLER, 2X EXHAUST</td><td>ENGINE</td><td>EXHAUST</td></tr>
</table>`;

    const extracted = service.extractGeneratorScheduleSnippet(snippet, 'port');

    expect(extracted).toContain('Spare Name: ZINCANODE');
    expect(extracted).toContain('Quantity: 2');
    expect(extracted).toContain('Location: BOX 26 VOLVO PENTA SPARES');
    expect(extracted).toContain('Manufacturer Part#: 913728');
    expect(extracted).toContain('Spare Name: ALUMINIUMSACRIFICAL');
    expect(extracted).toContain('Location: BOX 45 EXHAUST');
    expect(extracted).toContain('Manufacturer Part#: 805001A');
    expect(extracted).not.toContain('Spare Name: INSPECT / REPLACE ANODES');
    expect(extracted).not.toContain('Manufacturer Part#: ENGINE');
    expect(extracted).not.toContain('Supplier Part#: EXHAUST');
  });

  it('prefers the oil-related generator service row when a chunk contains multiple port-generator maintenance rows', () => {
    const snippet = `<table><caption> M/Y Seawolf X - Maintenance Tasks</caption>
<tr><td>0212 ENGINES</td><td>PS ENGINE</td><td>C MAIN GENERATOR 2000 HOURS SERVICE</td><td>1P49</td><td>Chief Engineer</td><td>4 Years / 2000 MAIN GENSET PS</td><td>07.07.2025 / 1534</td><td>07.07.2029 / 3534</td><td>EUR</td></tr>
<tr><td>REPLACE ALTERNATOR COOLANT PUMP</td></tr>
<tr><td>TEST OF THERMOSTATS</td></tr>
<tr><td>REPLACE ENGINE DRIVE BELT</td></tr>
<tr><td>0212 ENGINES</td><td>PS ENGINE</td><td>A MAIN GENERATOR 500 HOURS/ANNUAL SERVICE</td><td>1P47</td><td>Chief Engineer</td><td>1 Years / 500 MAIN GENSET PS</td><td>07.07.2025 / 1534</td><td>07.07.2026 / 2034</td><td>EUR</td></tr>
<tr><td>CHECK SOFTWARE STATUS</td></tr>
<tr><td>TAKE OIL SAMPLE</td></tr>
<tr><td>TAKE COOLANT SAMPLE</td></tr>
<tr><td>REPLACE OIL AND FILTERS</td></tr>
<tr><td>REPLACE FUEL PREFILTER AND FILTER</td></tr>
</table>`;

    const extracted = service.extractGeneratorScheduleSnippet(
      snippet,
      'port',
      'How do I change oil in the port generator?',
    );

    expect(extracted).toContain('Reference ID: 1P47');
    expect(extracted).toContain('REPLACE OIL AND FILTERS');
    expect(extracted).not.toContain('Reference ID: 1P49');
  });
});
