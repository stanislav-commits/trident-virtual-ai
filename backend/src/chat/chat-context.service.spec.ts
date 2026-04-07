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
          content:
            'The seawater pump impeller replacement interval is documented in the manual.',
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
            content:
              'Fallback seawater pump impeller maintenance procedure that still answers the query',
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

  it('uses a scoped chunk scan when scoped RAGFlow results produce no usable citations', async () => {
    const prisma = {
      ship: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ship-1',
            name: 'Sea Wolf X',
            ragflowDatasetId: 'dataset-1',
            manuals: [
              {
                id: 'manual-procedure',
                ragflowDocumentId: 'doc-procedure',
                filename: 'Operational Procedure.pdf',
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
          id: 'chunk-unmapped',
          doc_id: 'doc-other',
          doc_name: 'Other Manual.pdf',
          content: 'General operating procedure overview.',
          similarity: 0.94,
          meta: { page_num: 2 },
        },
      ]),
      listDocumentChunks: jest.fn().mockResolvedValue([
        {
          id: 'chunk-procedure',
          doc_id: 'doc-procedure',
          doc_name: 'Operational Procedure.pdf',
          content:
            'Bunkering procedure: prepare equipment, establish communication, start fueling, monitor flow rate, then secure the filling point.',
          meta: { page_num: 1 },
        },
      ]),
    };

    const service = new ChatContextService(prisma as never, ragflow as never);

    const citations = await service.findContextForAdminQuery(
      'i will have bunkering soon, describe me step by step procedure',
      2,
      2,
      ['MANUALS'],
      ['manual-procedure'],
    );

    expect(citations).toEqual([
      expect.objectContaining({
        shipManualId: 'manual-procedure',
        chunkId: 'chunk-procedure',
        sourceTitle: 'Operational Procedure.pdf (Sea Wolf X)',
        pageNumber: 1,
      }),
    ]);
    expect(ragflow.searchDataset).toHaveBeenCalledWith(
      'dataset-1',
      'i will have bunkering soon, describe me step by step procedure',
      48,
    );
    expect(ragflow.listDocumentChunks).toHaveBeenCalledWith(
      'dataset-1',
      'doc-procedure',
      300,
    );
  });

  it('rejects scoped chunk fallback matches that miss model or acronym anchors', async () => {
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
          id: 'chunk-generic-modes',
          doc_id: 'doc-tagged',
          doc_name: 'Tagged Manual.pdf',
          content:
            'The controller groups operating modes include automatic and manual operation.',
          meta: { page_num: 12 },
        },
      ]),
    };

    const service = new ChatContextService(prisma as never, ragflow as never);

    await expect(
      service.findContextForAdminQuery(
        'What are the UPS operating modes?',
        2,
        2,
        ['MANUALS'],
        ['manual-tagged'],
      ),
    ).resolves.toEqual([]);
  });

  it('keeps selected-manual fallback chunks when the answer uses a strong subject phrase instead of the source title', async () => {
    const prisma = {
      ship: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ship-1',
            name: 'Sea Wolf X',
            ragflowDatasetId: 'dataset-1',
            manuals: [
              {
                id: 'manual-catalogue',
                ragflowDocumentId: 'doc-catalogue',
                filename: 'Model 240 Spare Parts Catalogue.pdf',
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
          id: 'chunk-general',
          doc_id: 'doc-catalogue',
          doc_name: 'Model 240 Spare Parts Catalogue.pdf',
          content: 'TD240HCT pump body assembly and installation notes.',
          meta: { page_num: 3 },
        },
        {
          id: 'chunk-seal-kit',
          doc_id: 'doc-catalogue',
          doc_name: 'Model 240 Spare Parts Catalogue.pdf',
          content:
            '592.04014 - TD240HCT SEAL KIT CODE DESCRIPTION 381.10506 O-Ring 381.14086 O-Ring 382.14004 Lip Seal.',
          meta: { page_num: 5 },
        },
      ]),
    };

    const service = new ChatContextService(prisma as never, ragflow as never);

    const citations = await service.findContextForAdminQuery(
      'From Model 240 Spare Parts Catalogue.pdf document: Show me the spare parts for the Turbodrive 240 H.C.T. seal kit.',
      2,
      2,
      ['MANUALS'],
      ['manual-catalogue'],
    );

    expect(citations).toEqual([
      expect.objectContaining({
        shipManualId: 'manual-catalogue',
        chunkId: 'chunk-seal-kit',
        sourceTitle: 'Model 240 Spare Parts Catalogue.pdf (Sea Wolf X)',
        pageNumber: 5,
      }),
    ]);
  });

  it('prioritizes technical-data table evidence in scoped chunk fallback', async () => {
    const prisma = {
      ship: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ship-1',
            name: 'Sea Wolf X',
            ragflowDatasetId: 'dataset-1',
            manuals: [
              {
                id: 'manual-oil-separator',
                ragflowDocumentId: 'doc-oil-separator',
                filename: 'Oil Separator Manual.pdf',
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
          id: 'chunk-safety',
          doc_id: 'doc-oil-separator',
          doc_name: 'Oil Separator Manual.pdf',
          content:
            'Oil separator safety notes. Keep the separator clean and observe warning labels before maintenance.',
          meta: { page_num: 29 },
        },
        {
          id: 'chunk-component-rating',
          doc_id: 'doc-oil-separator',
          doc_name: 'Oil Separator Manual.pdf',
          content:
            'The maximum electrical contact rating stated on the nameplate must not be exceeded. Westfalia Separator Mineraloil Systems. <table><tr><td>Contact rating</td><td>250 V 4 A 100 W 50 Hz 1.0 kW</td></tr><tr><td>Oil separator service</td><td>rated contact capacity</td></tr></table>',
          meta: { page_num: 55 },
        },
        {
          id: 'chunk-technical-data',
          doc_id: 'doc-oil-separator',
          doc_name: 'Oil Separator Manual.pdf',
          content:
            'Technical Data2.15 <table><tr><td>Bowl</td><td>Rated bowl speed 8500 rpm</td></tr><tr><td>Throughput</td><td>2000 l/h</td></tr><tr><td>Density</td><td>991 kg/m3</td></tr></table>',
          meta: { page_num: 59 },
        },
      ]),
    };
    const service = new ChatContextService(prisma as never, ragflow as never);

    const citations = await service.findContextForAdminQuery(
      'What technical data is listed for the oil separator?',
      2,
      2,
      ['MANUALS'],
      ['manual-oil-separator'],
    );

    expect(citations[0]).toEqual(
      expect.objectContaining({
        shipManualId: 'manual-oil-separator',
        chunkId: 'chunk-technical-data',
        pageNumber: 59,
      }),
    );
  });

  it('filters RAGFlow hits that miss acronym/model evidence for high-anchor queries', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ship-1',
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-display',
              ragflowDocumentId: 'doc-display',
              filename: 'Display Manual.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-converter',
              ragflowDocumentId: 'doc-converter',
              filename: 'Converter Manual.pdf',
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
          id: 'chunk-generic-connect',
          doc_id: 'doc-display',
          doc_name: 'Display Manual.pdf',
          content:
            'Connect the remote display unit according to the wiring diagram.',
          similarity: 0.92,
          meta: { page_num: 37 },
        },
        {
          id: 'chunk-sdi-hdmi',
          doc_id: 'doc-converter',
          doc_name: 'Converter Manual.pdf',
          content:
            'Connect the SDI source to the SDI input and connect the HDMI display to the HDMI output.',
          similarity: 0.81,
          meta: { page_num: 4 },
        },
      ]),
    };

    const service = new ChatContextService(prisma as never, ragflow as never);

    const result = await service.findContextForQuery(
      'ship-1',
      'How do I connect an SDI source to an HDMI display?',
      2,
      2,
      ['MANUALS'],
    );

    expect(result.citations).toEqual([
      expect.objectContaining({
        shipManualId: 'manual-converter',
        chunkId: 'chunk-sdi-hdmi',
        sourceTitle: 'Converter Manual.pdf',
      }),
    ]);
  });

  it('keeps acronym evidence requirements when fallback queries are lowercased', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ship-1',
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-display',
              ragflowDocumentId: 'doc-display',
              filename: 'Display Manual.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-converter',
              ragflowDocumentId: 'doc-converter',
              filename: 'Converter Manual.pdf',
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
          id: 'chunk-generic-connect',
          doc_id: 'doc-display',
          doc_name: 'Display Manual.pdf',
          content:
            'Connect the remote display unit according to the wiring diagram.',
          similarity: 0.92,
          meta: { page_num: 37 },
        },
        {
          id: 'chunk-sdi-hdmi',
          doc_id: 'doc-converter',
          doc_name: 'Converter Manual.pdf',
          content:
            'Connect the SDI source to the SDI input and connect the HDMI display to the HDMI output.',
          similarity: 0.81,
          meta: { page_num: 4 },
        },
      ]),
    };

    const service = new ChatContextService(prisma as never, ragflow as never);

    const result = await service.findContextForQuery(
      'ship-1',
      'connect sdi source hdmi display',
      2,
      2,
      ['MANUALS'],
    );

    expect(result.citations).toEqual([
      expect.objectContaining({
        shipManualId: 'manual-converter',
        chunkId: 'chunk-sdi-hdmi',
        sourceTitle: 'Converter Manual.pdf',
      }),
    ]);
  });

  it('requires distinctive long subject terms before accepting generic matches', async () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ship-1',
          ragflowDatasetId: 'dataset-1',
          manuals: [
            {
              id: 'manual-application',
              ragflowDocumentId: 'doc-application',
              filename: 'Application Handbook.pdf',
              category: 'MANUALS',
            },
            {
              id: 'manual-waterjet',
              ragflowDocumentId: 'doc-waterjet',
              filename: 'Waterjet Manual.pdf',
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
          id: 'chunk-generic-application',
          doc_id: 'doc-application',
          doc_name: 'Application Handbook.pdf',
          content:
            'This application manual describes unit installation requirements and limits.',
          similarity: 0.94,
          meta: { page_num: 11 },
        },
        {
          id: 'chunk-waterjet-limits',
          doc_id: 'doc-waterjet',
          doc_name: 'Waterjet Manual.pdf',
          content:
            'Waterjet application limits include installation angle, operating draught and hull inlet constraints.',
          similarity: 0.82,
          meta: { page_num: 18 },
        },
      ]),
    };

    const service = new ChatContextService(prisma as never, ragflow as never);

    const result = await service.findContextForQuery(
      'ship-1',
      'What are the application limits for the waterjet unit?',
      2,
      2,
      ['MANUALS'],
    );

    expect(result.citations).toEqual([
      expect.objectContaining({
        shipManualId: 'manual-waterjet',
        chunkId: 'chunk-waterjet-limits',
        sourceTitle: 'Waterjet Manual.pdf',
      }),
    ]);
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
