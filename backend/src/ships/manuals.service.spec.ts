import { ManualsService } from './manuals.service';

describe('ManualsService bulk removal', () => {
  const buildService = () => {
    const prisma = {
      ship: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ship-1',
          ragflowDatasetId: 'dataset-1',
        }),
      },
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-1',
            shipId: 'ship-1',
            filename: 'manual-1.pdf',
            category: 'MANUALS',
            ragflowDocumentId: 'doc-1',
            uploadedAt: new Date('2026-03-22T10:00:00.000Z'),
            ship: { ragflowDatasetId: 'dataset-1' },
          },
          {
            id: 'manual-2',
            shipId: 'ship-1',
            filename: 'manual-2.pdf',
            category: 'MANUALS',
            ragflowDocumentId: 'doc-2',
            uploadedAt: new Date('2026-03-22T10:01:00.000Z'),
            ship: { ragflowDatasetId: 'dataset-1' },
          },
        ]),
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };

    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      deleteDocuments: jest.fn().mockResolvedValue(undefined),
      deleteDocument: jest.fn().mockResolvedValue(undefined),
    };

    const manualsParseScheduler = {
      notifyPendingDocuments: jest.fn(),
    };

    return {
      service: new ManualsService(
        prisma as never,
        ragflow as never,
        manualsParseScheduler as never,
      ),
      prisma,
      ragflow,
      manualsParseScheduler,
    };
  };

  it('deletes all selected RAGFlow documents in one bulk request', async () => {
    const { service, prisma, ragflow, manualsParseScheduler } = buildService();

    await expect(service.bulkRemove('ship-1', { mode: 'all' })).resolves.toEqual(
      {
        deletedCount: 2,
      },
    );

    expect(ragflow.deleteDocuments).toHaveBeenCalledWith('dataset-1', [
      'doc-1',
      'doc-2',
    ]);
    expect(ragflow.deleteDocument).not.toHaveBeenCalled();
    expect(prisma.shipManual.deleteMany).toHaveBeenCalledWith({
      where: {
        shipId: 'ship-1',
        id: { in: ['manual-1', 'manual-2'] },
      },
    });
    expect(manualsParseScheduler.notifyPendingDocuments).toHaveBeenCalled();
  });

  it('falls back to per-document cleanup when the bulk request fails', async () => {
    const { service, ragflow } = buildService();
    ragflow.deleteDocuments.mockRejectedValueOnce(new Error('bulk delete failed'));

    await expect(service.bulkRemove('ship-1', { mode: 'all' })).resolves.toEqual(
      {
        deletedCount: 2,
      },
    );

    expect(ragflow.deleteDocument).toHaveBeenCalledTimes(2);
    expect(ragflow.deleteDocument).toHaveBeenNthCalledWith(
      1,
      'dataset-1',
      'doc-1',
    );
    expect(ragflow.deleteDocument).toHaveBeenNthCalledWith(
      2,
      'dataset-1',
      'doc-2',
    );
  });

  it('limits mode=all removal to the requested knowledge base category', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.bulkRemove('ship-1', {
        mode: 'all',
        category: 'CERTIFICATES',
      }),
    ).resolves.toEqual({
      deletedCount: 2,
    });

    expect(prisma.shipManual.findMany).toHaveBeenCalledWith({
      where: {
        shipId: 'ship-1',
        category: 'CERTIFICATES',
      },
      include: {
        ship: true,
      },
      orderBy: {
        uploadedAt: 'desc',
      },
    });
  });
});
