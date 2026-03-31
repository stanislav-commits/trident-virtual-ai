import { ChatContextService } from './chat-context.service';

describe('ChatContextService', () => {
  it('filters retrieval results to the allowed document categories', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ship-1',
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-1',
              ragflowDocumentId: 'doc-manual',
              filename: 'Engine Manual.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-2',
              ragflowDocumentId: 'doc-history',
              filename: 'History Procedures.pdf',
              category: 'HISTORY_PROCEDURES',
            },
          ],
        }),
      },
    };
    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      searchDataset: jest.fn().mockResolvedValue([
        {
          id: 'chunk-history',
          doc_id: 'doc-history',
          doc_name: 'History Procedures.pdf',
          content: 'Last overhaul procedure details',
          similarity: 0.99,
          meta: { page_num: 12 },
        },
        {
          id: 'chunk-manual',
          doc_id: 'doc-manual',
          doc_name: 'Engine Manual.pdf',
          content: 'Replacement interval is documented in the manual',
          similarity: 0.94,
          meta: { page_num: 44 },
        },
      ]),
    };

    const service = new ChatContextService(prisma as never, ragflow as never);

    const result = await service.findContextForQuery(
      'ship-1',
      'replacement interval for the seawater pump impeller',
      2,
      2,
      ['MANUALS'],
    );

    expect(result.citations).toEqual([
      expect.objectContaining({
        shipManualId: 'manual-1',
        chunkId: 'chunk-manual',
        sourceTitle: 'Engine Manual.pdf',
        sourceCategory: 'MANUALS',
        pageNumber: 44,
      }),
    ]);
    expect((ragflow.searchDataset as jest.Mock).mock.calls[0][2]).toBeGreaterThan(2);
  });

  it('skips RAGFlow retrieval when the requested categories have no eligible documents', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ship-1',
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-2',
              ragflowDocumentId: 'doc-history',
              filename: 'History Procedures.pdf',
              category: 'HISTORY_PROCEDURES',
            },
          ],
        }),
      },
    };
    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      searchDataset: jest.fn(),
    };

    const service = new ChatContextService(prisma as never, ragflow as never);

    const result = await service.findContextForQuery(
      'ship-1',
      'which certificates expire soon',
      2,
      2,
      ['CERTIFICATES'],
    );

    expect(result.citations).toEqual([]);
    expect(ragflow.searchDataset).not.toHaveBeenCalled();
  });
});
