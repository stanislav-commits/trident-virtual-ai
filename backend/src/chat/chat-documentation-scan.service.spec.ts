import { ChatDocumentationQueryService } from './chat-documentation-query.service';
import { ChatDocumentationScanService } from './chat-documentation-scan.service';

describe('ChatDocumentationScanService', () => {
  const queryService = new ChatDocumentationQueryService();

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
          },
          {
            id: 'manual-ntvrp',
            ragflowDocumentId: 'doc-ntvrp',
            filename: 'SEAWOLF X - NTVRP 2025.pdf',
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
          },
          {
            id: 'manual-volvo',
            ragflowDocumentId: 'doc-volvo',
            filename: 'Volvo Penta operators manual.pdf',
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
});
