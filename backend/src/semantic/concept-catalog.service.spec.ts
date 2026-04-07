import { ConceptCatalogService } from './concept-catalog.service';

describe('ConceptCatalogService', () => {
  it('treats helm station control transfer as a manual control-system concept', async () => {
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as any;
    const service = new ConceptCatalogService(prisma);

    const candidates = await service.shortlistConcepts(
      'How do I transfer control to another helm station?',
      { limit: 4, minScore: 0 },
    );
    const helm = candidates.find(
      (candidate) => candidate.conceptId === 'helm_station_control',
    );
    const bunkering = candidates.find(
      (candidate) => candidate.conceptId === 'bunkering_operation',
    );

    expect(candidates[0]).toEqual(
      expect.objectContaining({
        conceptId: 'helm_station_control',
        family: 'asset_system',
      }),
    );
    expect(helm?.score ?? 0).toBeGreaterThan(bunkering?.score ?? 0);
  });
});
