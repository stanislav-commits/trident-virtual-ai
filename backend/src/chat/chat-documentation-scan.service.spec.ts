import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatDocumentationScanService } from './chat-documentation-scan.service';

describe('ChatDocumentationScanService', () => {
  const queryService = new ChatDocumentationQueryService();

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
    jest.spyOn(service as never, 'loadDocumentScanContexts' as never).mockResolvedValue([
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
                content:
                  'Fuel Tank 1P 3,142 liters Fuel Tank 2S 2,381 liters',
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
    jest.spyOn(service as never, 'loadDocumentScanContexts' as never).mockResolvedValue([
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
            "SHIPBOARD OIL POLLUTION EMERGENCY PLAN List Of Tank Capacities <table><caption> FUELOILTANKS</caption> <tr><td >TANK No</td><td >DESCRIPTION</td><td >IMP. GAL.</td><td >CAPACITY (It)</td><td >FRAME</td></tr> <tr><td >FO1.PS</td><td >Midship/Aft Port Fuel Tank</td><td></td><td >4970</td><td >12-15</td></tr> <tr><td >FO2.STBD</td><td >Midship/Aft Starboard Fuel Tank</td><td></td><td >4970</td><td >12-15</td></tr></table>",
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
              filename: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
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
            sourceTitle: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
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
    expect(citations[0]?.snippet).toContain('Replace fuel filter and prefilter');
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
              filename: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
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
            sourceTitle: 'MASE generators_44042 - VS 350 SV MUM EN rev.0 (1).pdf',
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
});
