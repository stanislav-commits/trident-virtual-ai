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
          meta: {
            page_num: 12,
            category: 'HISTORY_PROCEDURES',
            category_label: 'History Procedures',
          },
        },
        {
          id: 'chunk-manual',
          doc_id: 'doc-manual',
          doc_name: 'Engine Manual.pdf',
          content: 'Replacement interval is documented in the manual',
          similarity: 0.94,
          meta: {
            page_num: 44,
            category: 'MANUALS',
            category_label: 'Manuals',
          },
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
        sourceMetadataCategory: 'MANUALS',
        sourceMetadataCategoryLabel: 'Manuals',
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

  it('prefers tag-scoped manuals before running a broader document search', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ship-1',
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-tagged',
              ragflowDocumentId: 'doc-tagged',
              filename: 'Tagged Manual.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-other',
              ragflowDocumentId: 'doc-other',
              filename: 'Other Manual.pdf',
              category: 'MANUALS',
            },
          ],
        }),
      },
    };
    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      searchDataset: jest.fn().mockResolvedValue([
        {
          id: 'chunk-other',
          doc_id: 'doc-other',
          doc_name: 'Other Manual.pdf',
          content: 'Generic maintenance guidance',
          similarity: 0.99,
          meta: {
            page_num: 3,
            category: 'MANUALS',
            category_label: 'Manuals',
          },
        },
        {
          id: 'chunk-tagged',
          doc_id: 'doc-tagged',
          doc_name: 'Tagged Manual.pdf',
          content: 'Sea water pump impeller replacement steps',
          similarity: 0.88,
          meta: {
            page_num: 18,
            category: 'MANUALS',
            category_label: 'Manuals',
          },
        },
      ]),
    };
    const tagLinks = {
      findTaggedManualIdsForShipQuery: jest
        .fn()
        .mockResolvedValue(['manual-tagged']),
    };

    const service = new ChatContextService(
      prisma as never,
      ragflow as never,
      tagLinks as never,
    );

    const result = await service.findContextForQuery(
      'ship-1',
      'how do I replace the sea water pump impeller',
      2,
      2,
    );

    expect(result.citations).toEqual([
      expect.objectContaining({
        shipManualId: 'manual-tagged',
        chunkId: 'chunk-tagged',
        sourceTitle: 'Tagged Manual.pdf',
      }),
    ]);
    expect(tagLinks.findTaggedManualIdsForShipQuery).toHaveBeenCalledWith(
      'ship-1',
      'how do I replace the sea water pump impeller',
      undefined,
    );
    expect(ragflow.searchDataset).toHaveBeenCalledTimes(1);
    expect((ragflow.searchDataset as jest.Mock).mock.calls[0]).toEqual([
      'dataset-1',
      'how do I replace the sea water pump impeller',
      48,
    ]);
  });

  it('falls back to the broader document search when tag-scoped manuals return no evidence', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ship-1',
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-tagged',
              ragflowDocumentId: 'doc-tagged',
              filename: 'Tagged Manual.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-other',
              ragflowDocumentId: 'doc-other',
              filename: 'Other Manual.pdf',
              category: 'MANUALS',
            },
          ],
        }),
      },
    };
    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      searchDataset: jest
        .fn()
        .mockResolvedValueOnce([
          {
            id: 'chunk-other-first-pass',
            doc_id: 'doc-other',
            doc_name: 'Other Manual.pdf',
            content: 'Generic maintenance guidance',
            similarity: 0.99,
            meta: {
              page_num: 3,
              category: 'MANUALS',
              category_label: 'Manuals',
            },
          },
        ])
        .mockResolvedValueOnce([
          {
            id: 'chunk-other-fallback',
            doc_id: 'doc-other',
            doc_name: 'Other Manual.pdf',
            content: 'Fallback maintenance procedure that still answers the query',
            similarity: 0.91,
            meta: {
              page_num: 5,
              category: 'MANUALS',
              category_label: 'Manuals',
            },
          },
        ]),
    };
    const tagLinks = {
      findTaggedManualIdsForShipQuery: jest
        .fn()
        .mockResolvedValue(['manual-tagged']),
    };

    const service = new ChatContextService(
      prisma as never,
      ragflow as never,
      tagLinks as never,
    );

    const result = await service.findContextForQuery(
      'ship-1',
      'how do I replace the sea water pump impeller',
      2,
      2,
    );

    expect(result.citations).toEqual([
      expect.objectContaining({
        shipManualId: 'manual-other',
        chunkId: 'chunk-other-fallback',
        sourceTitle: 'Other Manual.pdf',
      }),
    ]);
    expect(ragflow.searchDataset).toHaveBeenCalledTimes(2);
    expect((ragflow.searchDataset as jest.Mock).mock.calls[0]).toEqual([
      'dataset-1',
      'how do I replace the sea water pump impeller',
      48,
    ]);
    expect((ragflow.searchDataset as jest.Mock).mock.calls[1]).toEqual([
      'dataset-1',
      'how do I replace the sea water pump impeller',
      2,
    ]);
  });

  it('uses a scoped chunk scan when RAGFlow retrieval fails for a selected manual', async () => {
    const prisma = {
      ship: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ship-1',
            name: 'Sea Wolf X',
            ragflowDatasetId: 'dataset-1',
            manuals: [
              {
                id: 'manual-ups',
                ragflowDocumentId: 'doc-ups',
                filename: 'UPS Manual.pdf',
                category: 'MANUALS',
              },
              {
                id: 'manual-other',
                ragflowDocumentId: 'doc-other',
                filename: 'Other Manual.pdf',
                category: 'MANUALS',
              },
            ],
          },
        ]),
      },
    };
    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      searchDataset: jest
        .fn()
        .mockRejectedValue(new Error('RAGFlow retrieval failed')),
      listDocumentChunks: jest.fn().mockResolvedValue([
        {
          id: 'chunk-unrelated',
          doc_id: 'doc-ups',
          doc_name: 'UPS Manual.pdf',
          content: 'Installation dimensions and cabinet clearances.',
          meta: { page_num: 2 },
        },
        {
          id: 'chunk-modes',
          doc_id: 'doc-ups',
          doc_name: 'UPS Manual.pdf',
          content:
            'UPS operating modes include normal mode, battery mode, bypass mode and ECO mode.',
          meta: {
            page_num: 8,
            category: 'MANUALS',
            category_label: 'Manuals',
          },
        },
      ]),
    };

    const service = new ChatContextService(prisma as never, ragflow as never);

    const citations = await service.findContextForAdminQuery(
      'What are the UPS operating modes?',
      2,
      2,
      ['MANUALS'],
      ['manual-ups'],
    );

    expect(citations).toEqual([
      expect.objectContaining({
        shipManualId: 'manual-ups',
        chunkId: 'chunk-modes',
        sourceTitle: 'UPS Manual.pdf (Sea Wolf X)',
        pageNumber: 8,
      }),
    ]);
    expect(ragflow.searchDataset).toHaveBeenCalledWith(
      'dataset-1',
      'What are the UPS operating modes?',
      48,
    );
    expect(ragflow.listDocumentChunks).toHaveBeenCalledWith(
      'dataset-1',
      'doc-ups',
      300,
    );
  });

  it('applies the same tag-first retrieval preference for admin document searches', async () => {
    const prisma = {
      ship: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ship-1',
            name: 'Sea Wolf X',
            ragflowDatasetId: 'dataset-1',
            manuals: [
              {
                id: 'manual-tagged',
                ragflowDocumentId: 'doc-tagged',
                filename: 'Tagged Manual.pdf',
                category: 'MANUALS',
              },
              {
                id: 'manual-other',
                ragflowDocumentId: 'doc-other',
                filename: 'Other Manual.pdf',
                category: 'MANUALS',
              },
            ],
          },
        ]),
      },
    };
    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      searchDataset: jest.fn().mockResolvedValue([
        {
          id: 'chunk-other',
          doc_id: 'doc-other',
          doc_name: 'Other Manual.pdf',
          content: 'Generic maintenance guidance',
          similarity: 0.97,
          meta: {
            page_num: 9,
            category: 'MANUALS',
            category_label: 'Manuals',
          },
        },
        {
          id: 'chunk-tagged',
          doc_id: 'doc-tagged',
          doc_name: 'Tagged Manual.pdf',
          content: 'Sea water pump impeller replacement steps',
          similarity: 0.84,
          meta: {
            page_num: 21,
            category: 'MANUALS',
            category_label: 'Manuals',
          },
        },
      ]),
    };
    const tagLinks = {
      findTaggedManualIdsForAdminQuery: jest
        .fn()
        .mockResolvedValue(['manual-tagged']),
    };

    const service = new ChatContextService(
      prisma as never,
      ragflow as never,
      tagLinks as never,
    );

    const citations = await service.findContextForAdminQuery(
      'how do I replace the sea water pump impeller',
      2,
      2,
    );

    expect(citations).toEqual([
      expect.objectContaining({
        shipManualId: 'manual-tagged',
        chunkId: 'chunk-tagged',
        sourceTitle: 'Tagged Manual.pdf (Sea Wolf X)',
      }),
    ]);
    expect(tagLinks.findTaggedManualIdsForAdminQuery).toHaveBeenCalledWith(
      'how do I replace the sea water pump impeller',
      undefined,
    );
    expect(ragflow.searchDataset).toHaveBeenCalledTimes(1);
    expect((ragflow.searchDataset as jest.Mock).mock.calls[0]).toEqual([
      'dataset-1',
      'how do I replace the sea water pump impeller',
      48,
    ]);
  });
});
