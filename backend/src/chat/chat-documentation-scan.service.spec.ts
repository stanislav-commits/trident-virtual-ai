import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatDocumentationScanService } from './chat-documentation-scan.service';

describe('ChatDocumentationScanService', () => {
  const queryService = new ChatDocumentationQueryService();
  const masePage69TextItems = [
    {
      text: '6.24 Periodic checks and maintenance',
      x: 180,
      y: 760,
      width: 180,
      height: 10,
    },
    {
      text: 'Perform service at intervals indicated',
      x: 120,
      y: 720,
      width: 180,
      height: 10,
    },
    {
      text: 'Every 200 hrs. or 12 Month',
      x: 304,
      y: 720,
      width: 90,
      height: 10,
    },
    {
      text: 'Every 500 hrs. or 12 Month',
      x: 358,
      y: 720,
      width: 90,
      height: 10,
    },
    {
      text: 'Every 1000 hrs. or 24 Month',
      x: 420,
      y: 720,
      width: 100,
      height: 10,
    },
    { text: 'Fuel system', x: 48, y: 666, width: 80, height: 10 },
    {
      text: 'Replace fuel filter and prefilter',
      x: 48,
      y: 648,
      width: 160,
      height: 10,
    },
    { text: '•', x: 358, y: 648, width: 6, height: 10 },
    { text: 'Lubrication system', x: 48, y: 624, width: 100, height: 10 },
    { text: 'Change oil and filter', x: 48, y: 606, width: 120, height: 10 },
    { text: '•', x: 358, y: 606, width: 6, height: 10 },
    { text: 'Cooling system', x: 48, y: 582, width: 100, height: 10 },
    {
      text: 'Check coolant levels in engine circuit / generator circuit',
      x: 48,
      y: 564,
      width: 240,
      height: 10,
    },
    { text: '•', x: 304, y: 564, width: 6, height: 10 },
    { text: '•', x: 358, y: 564, width: 6, height: 10 },
    {
      text: 'Clean the seawater filter',
      x: 48,
      y: 546,
      width: 140,
      height: 10,
    },
    { text: '•', x: 304, y: 546, width: 6, height: 10 },
    {
      text: 'Replace the seawater pump impeller',
      x: 48,
      y: 528,
      width: 170,
      height: 10,
    },
    { text: '•', x: 358, y: 528, width: 6, height: 10 },
    {
      text: 'Replace the seawater pump',
      x: 48,
      y: 510,
      width: 150,
      height: 10,
    },
    { text: '•', x: 420, y: 510, width: 6, height: 10 },
    {
      text: 'Replace the aux. pump belt (for alternator cooling)',
      x: 48,
      y: 492,
      width: 220,
      height: 10,
    },
    { text: '•', x: 358, y: 492, width: 6, height: 10 },
    { text: 'Gas intake / exhaust', x: 48, y: 456, width: 120, height: 10 },
    { text: 'Replace the air filter', x: 48, y: 438, width: 110, height: 10 },
    { text: '•', x: 358, y: 438, width: 6, height: 10 },
    {
      text: 'Check the exhaust flexible hose',
      x: 48,
      y: 420,
      width: 150,
      height: 10,
    },
    { text: '•', x: 358, y: 420, width: 6, height: 10 },
    { text: 'Electrical system', x: 48, y: 390, width: 100, height: 10 },
    {
      text: 'Clean the battery terminals',
      x: 48,
      y: 372,
      width: 140,
      height: 10,
    },
    { text: '•', x: 358, y: 372, width: 6, height: 10 },
    { text: 'Engine and assembly', x: 48, y: 342, width: 110, height: 10 },
    {
      text: 'Engine speed control and adjustment',
      x: 48,
      y: 324,
      width: 170,
      height: 10,
    },
    { text: '•', x: 358, y: 324, width: 6, height: 10 },
    {
      text: 'Check the engine ground connections',
      x: 48,
      y: 306,
      width: 180,
      height: 10,
    },
    { text: '•', x: 358, y: 306, width: 6, height: 10 },
    { text: 'Remote control system', x: 48, y: 276, width: 120, height: 10 },
    { text: 'Check software status', x: 48, y: 258, width: 120, height: 10 },
    { text: '•', x: 358, y: 258, width: 6, height: 10 },
  ];
  const masePage69RealisticTextItems = [
    {
      text: '6.24 Periodic checks and maintenance',
      x: 182,
      y: 793,
      width: 180,
      height: 10,
    },
    {
      text: 'Perform service at intervals indicated',
      x: 66,
      y: 726,
      width: 180,
      height: 10,
    },
    { text: 'Before', x: 231, y: 734, width: 24, height: 8 },
    { text: 'starting', x: 229, y: 726, width: 32, height: 8 },
    { text: 'Every 200', x: 316, y: 736, width: 40, height: 8 },
    { text: 'hrs.or 12', x: 316, y: 727, width: 40, height: 8 },
    { text: 'Month', x: 320, y: 719, width: 28, height: 8 },
    { text: 'Every 500', x: 347, y: 736, width: 40, height: 8 },
    { text: 'hrs.or 12', x: 348, y: 727, width: 40, height: 8 },
    { text: 'Month', x: 352, y: 719, width: 28, height: 8 },
    { text: '1000', x: 385, y: 737, width: 22, height: 8 },
    { text: 'hrs.or 24', x: 379, y: 729, width: 40, height: 8 },
    { text: 'Month', x: 382, y: 721, width: 28, height: 8 },
    { text: 'General', x: 31, y: 705, width: 42, height: 10 },
    { text: 'Fuel system', x: 31, y: 683, width: 70, height: 10 },
    {
      text: 'Water drainage in the water / diesel separator',
      x: 31,
      y: 670,
      width: 160,
      height: 10,
    },
    { text: '●', x: 238, y: 671, width: 6, height: 10 },
    {
      text: 'Replace fuel filter and prefilter',
      x: 31,
      y: 659,
      width: 140,
      height: 10,
    },
    { text: '●', x: 358, y: 660, width: 6, height: 10 },
    { text: 'Lubrication system', x: 31, y: 634, width: 100, height: 10 },
    { text: 'Change oil and filter', x: 31, y: 609, width: 120, height: 10 },
    { text: '●', x: 358, y: 611, width: 6, height: 10 },
    { text: 'Cooling system', x: 31, y: 593, width: 100, height: 10 },
    {
      text: 'Check coolant levels in engine circuit / generator circuit',
      x: 31,
      y: 579,
      width: 240,
      height: 10,
    },
    { text: '●', x: 266, y: 581, width: 6, height: 10 },
    { text: '●', x: 358, y: 581, width: 6, height: 10 },
    {
      text: 'Clean the seawater filter',
      x: 31,
      y: 566,
      width: 140,
      height: 10,
    },
    { text: '●', x: 326, y: 566, width: 6, height: 10 },
    {
      text: 'Replace the seawater pump impeller',
      x: 31,
      y: 554,
      width: 170,
      height: 10,
    },
    { text: '●', x: 358, y: 556, width: 6, height: 10 },
    {
      text: 'Replace the seawater pump',
      x: 31,
      y: 543,
      width: 150,
      height: 10,
    },
    { text: '●', x: 452, y: 545, width: 6, height: 10 },
    {
      text: 'Replace the aux. pump belt (for alternator cooling)',
      x: 31,
      y: 428,
      width: 220,
      height: 10,
    },
    { text: '●', x: 358, y: 429, width: 6, height: 10 },
    { text: 'Replace the air filter', x: 31, y: 315, width: 110, height: 10 },
    { text: '●', x: 358, y: 316, width: 6, height: 10 },
    {
      text: 'Check the exhaust flexible hose',
      x: 31,
      y: 303,
      width: 150,
      height: 10,
    },
    { text: '●', x: 358, y: 305, width: 6, height: 10 },
    {
      text: 'Clean the battery terminals',
      x: 31,
      y: 236,
      width: 140,
      height: 10,
    },
    { text: '●', x: 358, y: 238, width: 6, height: 10 },
    {
      text: 'Check drive belt and belt tensioner',
      x: 31,
      y: 195,
      width: 170,
      height: 10,
    },
    { text: '●', x: 358, y: 197, width: 6, height: 10 },
    {
      text: 'Engine speed control and adjustment',
      x: 31,
      y: 150,
      width: 170,
      height: 10,
    },
    { text: '●', x: 358, y: 152, width: 6, height: 10 },
    {
      text: 'Check the engine ground connections',
      x: 31,
      y: 139,
      width: 180,
      height: 10,
    },
    { text: '●', x: 358, y: 141, width: 6, height: 10 },
    { text: 'Check software status', x: 31, y: 73, width: 120, height: 10 },
    { text: '●', x: 358, y: 74, width: 6, height: 10 },
    { text: 'Generator operation test', x: 31, y: 50, width: 120, height: 10 },
    { text: '●', x: 238, y: 52, width: 6, height: 10 },
  ];
  const masePage69RealisticTextItemsWithLaterIntervals = [
    ...masePage69RealisticTextItems,
    { text: 'Every', x: 415, y: 745, width: 18, height: 8 },
    { text: '2000', x: 417, y: 737, width: 22, height: 8 },
    { text: 'hrs.or 48', x: 410, y: 729, width: 40, height: 8 },
    { text: 'Month', x: 414, y: 721, width: 28, height: 8 },
    {
      text: 'Check alternator coolant pump (Aux. pump)',
      x: 31,
      y: 415,
      width: 170,
      height: 10,
    },
    { text: 'в—Џ', x: 389, y: 417, width: 6, height: 10 },
    {
      text: 'Replace alternator coolant pump (Aux. pump)',
      x: 31,
      y: 402,
      width: 180,
      height: 10,
    },
    { text: 'в—Џ', x: 421, y: 404, width: 6, height: 10 },
    { text: 'Test of thermostats', x: 31, y: 389, width: 110, height: 10 },
    { text: 'в—Џ', x: 421, y: 391, width: 6, height: 10 },
    { text: 'Replace drive belt', x: 31, y: 184, width: 110, height: 10 },
    { text: 'в—Џ', x: 421, y: 186, width: 6, height: 10 },
    { text: 'Check valve clearance', x: 31, y: 116, width: 120, height: 10 },
    { text: 'в—Џ', x: 389, y: 118, width: 6, height: 10 },
  ];

  it('filters scan contexts to the allowed document categories before fallback selection', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-manual',
              ragflowDocumentId: 'doc-manual',
              filename: 'Volvo Penta operators manual.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-history',
              ragflowDocumentId: 'doc-history',
              filename: 'M_Y Seawolf X - Maintenance Tasks.pdf',
              category: 'HISTORY_PROCEDURES',
            },
          ],
        }),
        findMany: jest.fn(),
      },
    };
    const service = new ChatDocumentationScanService(
      prisma as never,
      { isConfigured: jest.fn().mockReturnValue(true) } as never,
      queryService,
      {} as never,
    );

    const contexts = await (
      service as unknown as {
        loadDocumentScanContexts: (
          shipId: string | null,
          citations: unknown[],
          allowedDocumentCategories?: string[],
        ) => Promise<
          Array<{
            ragflowDatasetId: string;
            manuals: Array<{ id: string; filename: string; category: string }>;
            score: number;
          }>
        >;
      }
    ).loadDocumentScanContexts('ship-1', [], ['MANUALS']);

    expect(contexts).toEqual([
      {
        ragflowDatasetId: 'dataset-1',
        manuals: [
          {
            id: 'manual-manual',
            ragflowDocumentId: 'doc-manual',
            filename: 'Volvo Penta operators manual.pdf',
            category: 'MANUALS',
          },
        ],
        score: Number.MAX_SAFE_INTEGER,
      },
    ]);
    expect(prisma.ship.findMany).not.toHaveBeenCalled();
  });

  it('filters scan contexts to tag-scoped manual ids when a conservative tag match exists', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-fuel',
              ragflowDocumentId: 'doc-fuel',
              filename: 'Fuel Tank Sounding Table.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-water',
              ragflowDocumentId: 'doc-water',
              filename: 'Fresh Water System.pdf',
              category: 'MANUALS',
            },
          ],
        }),
        findMany: jest.fn(),
      },
    };
    const service = new ChatDocumentationScanService(
      prisma as never,
      { isConfigured: jest.fn().mockReturnValue(true) } as never,
      queryService,
      {} as never,
    );

    const contexts = await (
      service as unknown as {
        loadDocumentScanContexts: (
          shipId: string | null,
          citations: unknown[],
          allowedDocumentCategories?: string[],
          allowedManualIds?: string[],
        ) => Promise<
          Array<{
            ragflowDatasetId: string;
            manuals: Array<{ id: string; filename: string; category: string }>;
            score: number;
          }>
        >;
      }
    ).loadDocumentScanContexts('ship-1', [], ['MANUALS'], ['manual-fuel']);

    expect(contexts).toEqual([
      {
        ragflowDatasetId: 'dataset-1',
        manuals: [
          {
            id: 'manual-fuel',
            ragflowDocumentId: 'doc-fuel',
            filename: 'Fuel Tank Sounding Table.pdf',
            category: 'MANUALS',
          },
        ],
        score: Number.MAX_SAFE_INTEGER,
      },
    ]);
    expect(prisma.ship.findMany).not.toHaveBeenCalled();
  });

  it('limits personnel-directory scans to dedicated contact documents when they are available', async () => {
    const ragflowService = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest
        .fn()
        .mockImplementation((_datasetId: string, documentId: string) => {
          if (documentId === 'doc-contact') {
            return Promise.resolve([
              {
                id: 'chunk-contact',
                content:
                  'James Kirby - Fleet Manager +34 680 664 753 jamesk@jmsyachting.com Carla Swaine - HR Manager +44 7494 320 951 carla@jmsyachting.com',
              },
            ]);
          }

          return Promise.resolve([
            {
              id: 'chunk-ntvrp',
              content:
                'Federal On - Insurance Manager 3.Notify P&I representatives shipping.master@cishipping.com +1345 815 1605',
            },
          ]);
        }),
    };
    const service = new ChatDocumentationScanService(
      {} as never,
      ragflowService as never,
      queryService,
      {} as never,
    );
    jest
      .spyOn(service as never, 'loadDocumentScanContexts' as never)
      .mockResolvedValue([
        {
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-contact',
              ragflowDocumentId: 'doc-contact',
              filename: 'JMS Company Contact Details Jan 26.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-ntvrp',
              ragflowDocumentId: 'doc-ntvrp',
              filename: 'SEAWOLF X - NTVRP 2025.pdf',
              category: 'HISTORY_PROCEDURES',
            },
          ],
          score: 1,
        },
      ]);

    const citations =
      await service.expandPersonnelDirectoryDocumentChunkCitations(
        'ship-1',
        'manager contact details',
        'list all managers with their contact details',
        [],
      );

    expect(ragflowService.listDocumentChunks).toHaveBeenCalledTimes(1);
    expect(ragflowService.listDocumentChunks).toHaveBeenCalledWith(
      'dataset-1',
      'doc-contact',
      300,
    );
    expect(citations).toEqual([
      expect.objectContaining({
        sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
      }),
    ]);
  });

  it('falls back to dataset search when personnel-directory chunk scan misses contact rows', async () => {
    const ragflowService = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest.fn().mockResolvedValue([]),
      searchDataset: jest.fn().mockResolvedValue([
        {
          id: 'search-contact',
          doc_id: 'doc-contact',
          doc_name: 'JMS Company Contact Details Jan 26.pdf',
          content:
            'James Kirby - Fleet Manager (M) +34 680 664 753 jamesk@jmsyachting.com Carla Swaine - HR Manager Global HSQE (M) +44 7494 320 951 carla@jmsyachting.com',
          similarity: 0.61,
        },
        {
          id: 'search-noise',
          doc_id: 'doc-monitor',
          doc_name: 'Display User Manual.pdf',
          content:
            'For service contact the manufacturer support centre at support@example.com.',
          similarity: 0.58,
        },
      ]),
    };
    const service = new ChatDocumentationScanService(
      {} as never,
      ragflowService as never,
      queryService,
      {} as never,
    );
    jest
      .spyOn(service as never, 'loadDocumentScanContexts' as never)
      .mockResolvedValue([
        {
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-contact',
              ragflowDocumentId: 'doc-contact',
              filename: 'JMS Company Contact Details Jan 26.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-monitor',
              ragflowDocumentId: 'doc-monitor',
              filename: 'Display User Manual.pdf',
              category: 'MANUALS',
            },
          ],
          score: 1,
        },
      ]);

    const citations =
      await service.expandPersonnelDirectoryDocumentChunkCitations(
        'ship-1',
        'manager contact details personnel directory company contact list',
        'list all managers with their contact details',
        [],
      );

    expect(ragflowService.searchDataset).toHaveBeenCalled();
    expect(citations).toEqual([
      expect.objectContaining({
        sourceTitle: 'JMS Company Contact Details Jan 26.pdf',
        snippet: expect.stringContaining('Fleet Manager'),
      }),
    ]);
  });

  it('collects tank rows from sounding tables even when the row omits the word capacity', async () => {
    const ragflowService = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest
        .fn()
        .mockImplementation((_datasetId: string, documentId: string) => {
          if (documentId === 'doc-tanks') {
            return Promise.resolve([
              {
                id: 'chunk-tanks',
                content: 'Fuel Tank 1P 3,142 liters Fuel Tank 2S 2,381 liters',
              },
            ]);
          }

          return Promise.resolve([
            {
              id: 'chunk-manual',
              content:
                'The operator manual discusses fuel systems but does not list tank capacities.',
            },
          ]);
        }),
    };
    const service = new ChatDocumentationScanService(
      {} as never,
      ragflowService as never,
      queryService,
      {} as never,
    );
    jest
      .spyOn(service as never, 'loadDocumentScanContexts' as never)
      .mockResolvedValue([
        {
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-tanks',
              ragflowDocumentId: 'doc-tanks',
              filename: 'Fuel Tank Sounding Table.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-volvo',
              ragflowDocumentId: 'doc-volvo',
              filename: 'Volvo Penta operators manual.pdf',
              category: 'MANUALS',
            },
          ],
          score: 1,
        },
      ]);

    const citations = await service.expandTankCapacityDocumentChunkCitations(
      'ship-1',
      'show tank capacities for fuel tanks',
      'show tank capacities for fuel tanks',
      [],
      ['MANUALS'],
    );

    expect(ragflowService.listDocumentChunks).toHaveBeenCalledTimes(1);
    expect(ragflowService.listDocumentChunks).toHaveBeenCalledWith(
      'dataset-1',
      'doc-tanks',
      300,
    );
    expect(citations).toEqual([
      expect.objectContaining({
        sourceTitle: 'Fuel Tank Sounding Table.pdf',
        snippet: 'Fuel Tank 1P 3,142 liters Fuel Tank 2S 2,381 liters',
      }),
    ]);
  });

  it('falls back to RAGFlow retrieval when tank tables live in a generically named document', async () => {
    const ragflowService = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest.fn().mockResolvedValue([
        {
          id: 'chunk-empty',
          content: 'General vessel document text without tank-capacity rows.',
        },
      ]),
      searchDataset: jest.fn().mockResolvedValue([
        {
          id: 'search-sopep',
          doc_id: 'doc-sopep',
          content:
            'SHIPBOARD OIL POLLUTION EMERGENCY PLAN List Of Tank Capacities <table><caption> FUELOILTANKS</caption> <tr><td >TANK No</td><td >DESCRIPTION</td><td >IMP. GAL.</td><td >CAPACITY (It)</td><td >FRAME</td></tr> <tr><td >FO1.PS</td><td >Midship/Aft Port Fuel Tank</td><td></td><td >4970</td><td >12-15</td></tr> <tr><td >FO2.STBD</td><td >Midship/Aft Starboard Fuel Tank</td><td></td><td >4970</td><td >12-15</td></tr></table>',
          similarity: 0.98,
        },
      ]),
    };
    const service = new ChatDocumentationScanService(
      {} as never,
      ragflowService as never,
      queryService,
      {} as never,
    );
    jest
      .spyOn(service as never, 'loadDocumentScanContexts' as never)
      .mockResolvedValue([
        {
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-sopep',
              ragflowDocumentId: 'doc-sopep',
              filename: 'Seawolf X SOPEP.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-volvo',
              ragflowDocumentId: 'doc-volvo',
              filename: 'Volvo Penta operators manual.pdf',
              category: 'MANUALS',
            },
          ],
          score: 1,
        },
      ]);

    const citations = await service.expandTankCapacityDocumentChunkCitations(
      'ship-1',
      'show tank capacities for fuel tanks',
      'show tank capacities for fuel tanks',
      [],
      ['MANUALS'],
    );

    expect(ragflowService.searchDataset).toHaveBeenCalled();
    expect(citations).toEqual([
      expect.objectContaining({
        sourceTitle: 'Seawolf X SOPEP.pdf',
        snippet: expect.stringContaining('List Of Tank Capacities'),
      }),
    ]);
  });

  it('rescues interval-maintenance table chunks from a manual when the initial citation only matched an incidental number', async () => {
    const ragflowService = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest
        .fn()
        .mockImplementation((_datasetId: string, documentId: string) => {
          if (documentId !== 'doc-mase') {
            return Promise.resolve([]);
          }

          return Promise.resolve([
            {
              id: 'chunk-fuel-circuit',
              content:
                '3.8 Fuel Circuit. The generator is diesel-powered. For differences in level higher than 500 mm, fit a non-return valve.',
              meta: { page_num: 28 },
            },
            {
              id: 'chunk-maintenance-table',
              content:
                '6.24 Periodic checks and maintenance <table><tr><td>Fuel system</td><td>Replace fuel filter and prefilter</td><td>Every 500 hrs. or 12 Month</td></tr><tr><td>Lubrication system</td><td>Change oil and filter</td><td>Every 500 hrs. or 12 Month</td></tr></table>',
              meta: { page_num: 69 },
            },
          ]);
        }),
    };
    const service = new ChatDocumentationScanService(
      {} as never,
      ragflowService as never,
      queryService,
      {} as never,
    );
    jest
      .spyOn(service as never, 'loadDocumentScanContexts' as never)
      .mockResolvedValue([
        {
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-mase',
              ragflowDocumentId: 'doc-mase',
              filename:
                'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
              category: 'MANUALS',
            },
          ],
          score: 1,
        },
      ]);

    const citations =
      await service.expandManualIntervalMaintenanceChunkCitations(
        'ship-1',
        'what shoul i do at 500 hourly diesel generator maintenanace?',
        'what shoul i do at 500 hourly diesel generator maintenanace?',
        [
          {
            shipManualId: 'manual-mase',
            sourceTitle:
              'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
            snippet:
              '3.8 Fuel Circuit. The generator is diesel-powered. For differences in level higher than 500 mm, fit a non-return valve.',
            score: 0.97,
          },
        ],
        ['MANUALS'],
      );

    expect(citations[0]).toEqual(
      expect.objectContaining({
        sourceTitle: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
        pageNumber: 69,
        snippet: expect.stringContaining('Periodic checks and maintenance'),
      }),
    );
    expect(citations[0]?.snippet).toContain(
      'Replace fuel filter and prefilter',
    );
    expect(citations[0]?.snippet).toContain('Every 500 hrs');
  });

  it('rescues hyphenated 500-hour maintenance list phrasing from the maintenance table', async () => {
    const ragflowService = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest.fn().mockResolvedValue([
        {
          id: 'chunk-fuel-circuit',
          content:
            '3.8 Fuel Circuit. The generator is diesel-powered. For differences in level higher than 500 mm, fit a non-return valve.',
          meta: { page_num: 28 },
        },
        {
          id: 'chunk-maintenance-table',
          content:
            '6.24 Periodic checks and maintenance <table><tr><td>Fuel system</td><td>Replace fuel filter and prefilter</td><td>Every 500 hrs. or 12 Month</td></tr><tr><td>Lubrication system</td><td>Change oil and filter</td><td>Every 500 hrs. or 12 Month</td></tr></table>',
          meta: { page_num: 69 },
        },
      ]),
    };
    const service = new ChatDocumentationScanService(
      {} as never,
      ragflowService as never,
      queryService,
      {} as never,
    );
    jest
      .spyOn(service as never, 'loadDocumentScanContexts' as never)
      .mockResolvedValue([
        {
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-mase',
              ragflowDocumentId: 'doc-mase',
              filename:
                'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
              category: 'MANUALS',
            },
          ],
          score: 1,
        },
      ]);

    const citations =
      await service.expandManualIntervalMaintenanceChunkCitations(
        'ship-1',
        'list all 500-hour maintenance items for the diesel generator',
        'list all 500-hour maintenance items for the diesel generator',
        [
          {
            shipManualId: 'manual-mase',
            sourceTitle:
              'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
            snippet:
              '3.8 Fuel Circuit. The generator is diesel-powered. For differences in level higher than 500 mm, fit a non-return valve.',
            score: 0.97,
          },
        ],
        ['MANUALS'],
      );

    expect(citations[0]).toEqual(
      expect.objectContaining({
        sourceTitle: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
        pageNumber: 69,
        snippet: expect.stringContaining('Periodic checks and maintenance'),
      }),
    );
    expect(citations[0]?.snippet).toContain('Change oil and filter');
    expect(citations[0]?.snippet).toContain('Every 500 hrs');
  });

  it('prefers the strongest maintenance-table page group over an earlier cross-page chunk when scoring ties', async () => {
    const ragflowService = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest.fn().mockResolvedValue([
        {
          id: 'chunk-page-68-cross',
          content:
            'SCR System maintenance note. 6.24 Periodic checks and maintenance <table><tr><td>Fuel system</td><td>Replace fuel filter and prefilter</td><td>Every 500 hrs. or 12 Month</td></tr></table>',
          meta: { page_num: 68 },
        },
        {
          id: 'chunk-page-69-table-top',
          content:
            '6.24 Periodic checks and maintenance <table><tr><td>Fuel system</td><td>Replace fuel filter and prefilter</td><td>Every 500 hrs. or 12 Month</td></tr><tr><td>Lubrication system</td><td>Change oil and filter</td><td>Every 500 hrs. or 12 Month</td></tr></table>',
          meta: { page_num: 69 },
        },
        {
          id: 'chunk-page-69-table-bottom',
          content:
            '<table><tr><td>Cooling system</td><td>Replace the seawater pump</td><td>Every 500 hrs. or 12 Month</td></tr><tr><td>Cooling system</td><td>Replace alternator coolant pump (Aux. pump)</td><td>Every 500 hrs. or 12 Month</td></tr></table>',
          meta: { page_num: 69 },
        },
      ]),
    };
    const service = new ChatDocumentationScanService(
      {} as never,
      ragflowService as never,
      queryService,
      {} as never,
    );
    jest
      .spyOn(service as never, 'loadDocumentScanContexts' as never)
      .mockResolvedValue([
        {
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-mase',
              ragflowDocumentId: 'doc-mase',
              filename:
                'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
              category: 'MANUALS',
            },
          ],
          score: 1,
        },
      ]);

    const citations =
      await service.expandManualIntervalMaintenanceChunkCitations(
        'ship-1',
        'what is included in the 500-hour diesel generator maintenance?',
        'what is included in the 500-hour diesel generator maintenance?',
        [
          {
            shipManualId: 'manual-mase',
            sourceTitle:
              'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
            snippet:
              '3.8 Fuel Circuit. The generator is diesel-powered. For differences in level higher than 500 mm, fit a non-return valve.',
            score: 0.97,
          },
        ],
        ['MANUALS'],
      );

    expect(citations[0]).toEqual(
      expect.objectContaining({
        sourceTitle: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
        pageNumber: 69,
      }),
    );
    expect(citations[0]?.snippet).toContain('Change oil and filter');
    expect(citations[0]?.snippet).not.toContain('SCR System maintenance note');
  });

  it('extracts the requested narrative maintenance interval instead of a nearby first-service section', () => {
    const service = new ChatDocumentationScanService(
      {} as never,
      {} as never,
      queryService,
      {} as never,
    );

    const extracted = (
      service as unknown as {
        extractNarrativeIntervalMaintenanceSnippet: (
          text: string,
          query: string,
          intervalPhrases: string[],
        ) => {
          heading?: string;
          intervalLabel: string;
          items: string[];
        } | null;
      }
    ).extractNarrativeIntervalMaintenanceSnippet(
      [
        '4.2 Operations to be carried out after the first 50 working hours:',
        '· Check that all screws are properly tight, paying special care to the head and crank case.',
        '· Replace the lubricant with one of the recommended oils.',
        '4.3Weekly operations:',
        '· Check the oil level and if necessary, top up. Do not exceed the mark corresponding to the max. level.',
        '·Drain condensation by opening the cock located under the tank; as soon as air flows out, turn off the cock.',
      ].join(' '),
      'weekly maintenance for air compressor',
      ['weekly', 'weekly operations', 'weekly maintenance', 'once per week'],
    );

    expect(extracted?.intervalLabel).toContain('Weekly operations');
    expect(extracted?.items).toEqual(
      expect.arrayContaining([
        'Check the oil level and if necessary, top up. Do not exceed the mark corresponding to the max. level',
        'Drain condensation by opening the cock located under the tank; as soon as air flows out, turn off the cock',
      ]),
    );
    expect(extracted?.items.join('\n')).not.toContain('Replace the lubricant');
  });

  it('extracts all due items from interval-maintenance table text positions for the requested interval', () => {
    const service = new ChatDocumentationScanService(
      {} as never,
      {} as never,
      queryService,
      {} as never,
    );

    const extracted = (
      service as unknown as {
        extractIntervalMaintenanceItemsFromTextItems: (
          textItems: Array<{
            text: string;
            x: number;
            y: number;
            width: number;
            height: number;
          }>,
          query: string,
          intervalPhrases: string[],
        ) => {
          heading?: string;
          intervalLabel: string;
          items: string[];
        } | null;
      }
    ).extractIntervalMaintenanceItemsFromTextItems(
      masePage69TextItems,
      'what shoul i do at 500 hourly diesel generator maintenanace?',
      ['500 hour', '500 hours', '500 hrs', 'every 500'],
    );

    expect(extracted).toEqual(
      expect.objectContaining({
        heading: expect.stringContaining('Periodic checks and maintenance'),
        intervalLabel: expect.stringContaining('Every 500'),
      }),
    );
    expect(extracted?.items).toEqual(
      expect.arrayContaining([
        'Replace fuel filter and prefilter',
        'Change oil and filter',
        'Check coolant levels in engine circuit / generator circuit',
        'Replace the seawater pump impeller',
        'Replace the aux. pump belt (for alternator cooling)',
        'Replace the air filter',
        'Check the exhaust flexible hose',
        'Clean the battery terminals',
        'Engine speed control and adjustment',
        'Check the engine ground connections',
        'Check software status',
      ]),
    );
    expect(extracted?.items).not.toContain('Clean the seawater filter');
    expect(extracted?.items).not.toContain('Replace the seawater pump');
  });

  it('keeps the upper body rows when a maintenance table has a tall title and header block', () => {
    const service = new ChatDocumentationScanService(
      {} as never,
      { isConfigured: jest.fn().mockReturnValue(true) } as never,
      queryService,
      {} as never,
    );

    const extracted = (
      service as unknown as {
        extractIntervalMaintenanceItemsFromTextItems: (
          items: Array<{
            text: string;
            x: number;
            y: number;
            width: number;
            height: number;
          }>,
          query: string,
          intervalPhrases: string[],
        ) => {
          heading?: string;
          intervalLabel: string;
          items: string[];
        } | null;
      }
    ).extractIntervalMaintenanceItemsFromTextItems(
      masePage69RealisticTextItems,
      'what shoul i do at 500 hourly diesel generator maintenanace?',
      ['500 hour', '500 hours', '500 hrs', 'every 500'],
    );

    expect(extracted?.items).toEqual(
      expect.arrayContaining([
        'Replace fuel filter and prefilter',
        'Change oil and filter',
        'Replace the seawater pump impeller',
      ]),
    );
    expect(extracted?.items).not.toContain('Replace the seawater pump');
  });

  it('does not leak later interval rows into the selected 500-hour column', () => {
    const service = new ChatDocumentationScanService(
      {} as never,
      { isConfigured: jest.fn().mockReturnValue(true) } as never,
      queryService,
      {} as never,
    );

    const extracted = (
      service as unknown as {
        extractIntervalMaintenanceItemsFromTextItems: (
          items: Array<{
            text: string;
            x: number;
            y: number;
            width: number;
            height: number;
          }>,
          query: string,
          intervalPhrases: string[],
        ) => {
          heading?: string;
          intervalLabel: string;
          items: string[];
        } | null;
      }
    ).extractIntervalMaintenanceItemsFromTextItems(
      masePage69RealisticTextItemsWithLaterIntervals,
      'what shoul i do at 500 hourly diesel generator maintenanace?',
      ['500 hour', '500 hours', '500 hrs', 'every 500'],
    );

    expect(extracted?.items).toEqual(
      expect.arrayContaining([
        'Replace fuel filter and prefilter',
        'Replace the aux. pump belt (for alternator cooling)',
      ]),
    );
    expect(extracted?.items).not.toContain(
      'Check alternator coolant pump (Aux. pump)',
    );
    expect(extracted?.items).not.toContain(
      'Replace alternator coolant pump (Aux. pump)',
    );
    expect(extracted?.items).not.toContain('Test of thermostats');
    expect(extracted?.items).not.toContain('Replace drive belt');
    expect(extracted?.items).not.toContain('Check valve clearance');
  });

  it('merges wrapped interval-table descriptions even when the marker is rendered on the continuation line', () => {
    const service = new ChatDocumentationScanService(
      {} as never,
      { isConfigured: jest.fn().mockReturnValue(true) } as never,
      queryService,
      {} as never,
    );
    const wrappedTextItems = [
      {
        text: 'Periodic checks and maintenance',
        x: 180,
        y: 760,
        width: 180,
        height: 10,
      },
      {
        text: 'Perform service at intervals indicated',
        x: 90,
        y: 720,
        width: 180,
        height: 10,
      },
      { text: 'Every 200', x: 316, y: 736, width: 40, height: 8 },
      { text: 'hrs.or 12', x: 316, y: 727, width: 40, height: 8 },
      { text: 'Month', x: 320, y: 719, width: 28, height: 8 },
      { text: 'Cooling system', x: 31, y: 690, width: 100, height: 10 },
      {
        text: 'Verify and adjust the tension of the aux. pump belt',
        x: 31,
        y: 676,
        width: 220,
        height: 10,
      },
      { text: 'b', x: 252, y: 676, width: 6, height: 10 },
      { text: '(for', x: 252, y: 676, width: 18, height: 10 },
      { text: 'alternator cooling)', x: 31, y: 664, width: 90, height: 10 },
      { text: '●', x: 326, y: 664, width: 6, height: 10 },
    ];

    const extracted = (
      service as unknown as {
        extractIntervalMaintenanceItemsFromTextItems: (
          items: Array<{
            text: string;
            x: number;
            y: number;
            width: number;
            height: number;
          }>,
          query: string,
          intervalPhrases: string[],
        ) => {
          heading?: string;
          intervalLabel: string;
          items: string[];
        } | null;
      }
    ).extractIntervalMaintenanceItemsFromTextItems(
      wrappedTextItems,
      'what is due every 200 hours or 12 months on the diesel generator?',
      [
        '200 hour',
        '200 hours',
        '200 hrs',
        '12 month',
        '12 months',
        'every 200',
      ],
    );

    expect(extracted?.items).toContain(
      'Verify and adjust the tension of the aux. pump belt (for alternator cooling)',
    );
    expect(extracted?.items).not.toContain('alternator cooling)');
  });

  it('extracts maintenance-as-needed rows from interval-maintenance tables', () => {
    const service = new ChatDocumentationScanService(
      {} as never,
      { isConfigured: jest.fn().mockReturnValue(true) } as never,
      queryService,
      {} as never,
    );
    const asNeededTextItems = [
      {
        text: 'Periodic checks and maintenance',
        x: 180,
        y: 760,
        width: 180,
        height: 10,
      },
      {
        text: 'Perform service at intervals indicated',
        x: 90,
        y: 720,
        width: 180,
        height: 10,
      },
      { text: 'Maintenance', x: 520, y: 736, width: 50, height: 8 },
      { text: 'as needed', x: 520, y: 727, width: 50, height: 8 },
      { text: 'Fuel system', x: 31, y: 690, width: 100, height: 10 },
      { text: 'Check the fuel pump', x: 31, y: 676, width: 120, height: 10 },
      { text: '●', x: 534, y: 676, width: 6, height: 10 },
      { text: 'Cooling system', x: 31, y: 650, width: 100, height: 10 },
      { text: 'Add coolant', x: 31, y: 636, width: 80, height: 10 },
      { text: '●', x: 534, y: 636, width: 6, height: 10 },
      { text: 'Gas intake / exhaust', x: 31, y: 610, width: 120, height: 10 },
      { text: 'Clean the air filter', x: 31, y: 596, width: 110, height: 10 },
      { text: '●', x: 534, y: 596, width: 6, height: 10 },
      { text: 'Engine and assembly', x: 31, y: 570, width: 120, height: 10 },
      {
        text: 'Check and adjust the fuel injection pump',
        x: 31,
        y: 556,
        width: 190,
        height: 10,
      },
      { text: '●', x: 534, y: 556, width: 6, height: 10 },
    ];

    const extracted = (
      service as unknown as {
        extractIntervalMaintenanceItemsFromTextItems: (
          items: Array<{
            text: string;
            x: number;
            y: number;
            width: number;
            height: number;
          }>,
          query: string,
          intervalPhrases: string[],
        ) => {
          heading?: string;
          intervalLabel: string;
          items: string[];
        } | null;
      }
    ).extractIntervalMaintenanceItemsFromTextItems(
      asNeededTextItems,
      'what maintenance is listed as needed for the diesel generator?',
      ['as needed', 'maintenance as needed'],
    );

    expect(extracted?.intervalLabel).toContain('Maintenance as needed');
    expect(extracted?.items).toEqual(
      expect.arrayContaining([
        'Check the fuel pump',
        'Add coolant',
        'Clean the air filter',
        'Check and adjust the fuel injection pump',
      ]),
    );
  });

  it('uses structured PDF page extraction to replace incomplete merged interval snippets', async () => {
    const ragflowService = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest.fn().mockResolvedValue([
        {
          id: 'chunk-fuel-circuit',
          content:
            '3.8 Fuel Circuit. The generator is diesel-powered. For differences in level higher than 500 mm, fit a non-return valve.',
          meta: { page_num: 28 },
        },
        {
          id: 'chunk-maintenance-table',
          content:
            '6.24 Periodic checks and maintenance <table><tr><td>Cooling system</td><td>Check coolant levels in engine circuit/ generator circuit Clean the seawater filter</td><td>Every 500 hrs. or 12 Month</td></tr><tr><td>Replace the seawater pump</td><td>Every 500 hrs. or 12 Month</td></tr></table>',
          meta: { page_num: 69 },
        },
      ]),
      downloadDocument: jest.fn().mockResolvedValue({
        buffer: Buffer.from('%PDF-1.4'),
        filename: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
        contentType: 'application/pdf',
      }),
    };
    const service = new ChatDocumentationScanService(
      {} as never,
      ragflowService as never,
      queryService,
      {} as never,
    );
    jest
      .spyOn(service as never, 'loadDocumentScanContexts' as never)
      .mockResolvedValue([
        {
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-mase',
              ragflowDocumentId: 'doc-mase',
              filename:
                'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
              category: 'MANUALS',
            },
          ],
          score: 1,
        },
      ]);
    jest
      .spyOn(service as never, 'loadPdfPageTextItems' as never)
      .mockResolvedValue(masePage69TextItems);

    const citations =
      await service.expandManualIntervalMaintenanceChunkCitations(
        'ship-1',
        'what shoul i do at 500 hourly diesel generator maintenanace?',
        'what shoul i do at 500 hourly diesel generator maintenanace?',
        [
          {
            shipManualId: 'manual-mase',
            sourceTitle:
              'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
            snippet:
              '3.8 Fuel Circuit. The generator is diesel-powered. For differences in level higher than 500 mm, fit a non-return valve.',
            score: 0.97,
          },
        ],
        ['MANUALS'],
      );

    expect(ragflowService.downloadDocument).toHaveBeenCalledWith(
      'dataset-1',
      'doc-mase',
    );
    expect(citations[0]).toEqual(
      expect.objectContaining({
        sourceTitle: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
        pageNumber: 69,
        snippet: expect.stringContaining('Replace fuel filter and prefilter'),
      }),
    );
    expect(citations[0]?.snippet).toContain(
      'Replace the seawater pump impeller',
    );
    expect(citations[0]?.snippet).not.toContain('Replace the seawater pump\n');
    expect(citations[0]?.snippet).not.toContain('Clean the seawater filter');
  });
});
