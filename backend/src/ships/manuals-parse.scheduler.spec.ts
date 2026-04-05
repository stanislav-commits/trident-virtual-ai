import { ManualsParseScheduler } from './manuals-parse.scheduler';

describe('ManualsParseScheduler retryable failures', () => {
  const buildScheduler = (
    run: string,
    progressMsg: string,
    chunkCount: number = 0,
  ) => {
    const prisma = {
      ship: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'ship-1',
            ragflowDatasetId: 'dataset-1',
          },
        ]),
      },
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'manual-1', ragflowDocumentId: 'doc-1' },
        ]),
      },
    };

    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocuments: jest.fn().mockResolvedValue([
        {
          id: 'doc-1',
          name: 'manual.pdf',
          run,
          progress: 0,
          progress_msg: progressMsg,
          chunk_count: chunkCount,
          token_count: 0,
        },
      ]),
      parseDocuments: jest.fn().mockResolvedValue(undefined),
    };

    const tagLinks = {
      autoLinkManuals: jest.fn().mockResolvedValue({
        processed: 1,
        linked: 1,
        untouched: 0,
        cleared: 0,
      }),
    };

    return {
      scheduler: new ManualsParseScheduler(
        prisma as never,
        ragflow as never,
        tagLinks as never,
      ),
      ragflow,
      tagLinks,
    };
  };

  it('retries a known RAGFlow chunking failure once', async () => {
    const { scheduler, ragflow } = buildScheduler(
      'FAIL',
      "Coordinate 'lower' is less than 'upper'",
    );

    await scheduler.drainPendingDocuments();
    await scheduler.drainPendingDocuments();

    expect(ragflow.parseDocuments).toHaveBeenCalledTimes(1);
    expect(ragflow.parseDocuments).toHaveBeenCalledWith('dataset-1', ['doc-1']);
  });

  it('does not retry unrelated failed parses', async () => {
    const { scheduler, ragflow } = buildScheduler(
      'FAIL',
      'The uploaded file is corrupted',
    );

    await scheduler.drainPendingDocuments();

    expect(ragflow.parseDocuments).not.toHaveBeenCalled();
  });

  it('refreshes content-assisted tags for completed parsed manuals', async () => {
    const { scheduler, ragflow, tagLinks } = buildScheduler(
      'DONE',
      'completed',
      18,
    );

    await scheduler.drainPendingDocuments();

    expect(tagLinks.autoLinkManuals).toHaveBeenCalledWith(['manual-1']);
    expect(ragflow.parseDocuments).not.toHaveBeenCalled();
  });
});
