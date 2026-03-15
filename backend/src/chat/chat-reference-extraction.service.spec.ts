import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatReferenceExtractionService } from './chat-reference-extraction.service';

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
});
