import { TagLinksService } from '../../../src/tags/tag-links.service';
import { TagMatcherService } from '../../../src/tags/tag-matcher.service';

describe('TagLinksService', () => {
  it('rejects attempts to assign more than one tag to a metric', async () => {
    const prisma = {
      metricDefinition: {
        findUnique: jest.fn().mockResolvedValue({ key: 'metric-1' }),
      },
    };
    const service = new TagLinksService(prisma as never, {} as never);

    await expect(
      service.replaceMetricTags('metric-1', ['tag-1', 'tag-2']),
    ).rejects.toThrow('Only one tag can be linked to a metric');
  });

  it('allows assigning multiple tags to a manual', async () => {
    const shipManualTag = {
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest.fn().mockResolvedValue([
        {
          tag: {
            id: 'tag-1',
            key: 'equipment:fuel:storage_tank',
            category: 'equipment',
            subcategory: 'fuel',
            item: 'storage_tank',
            description: 'Fuel tank.',
          },
        },
        {
          tag: {
            id: 'tag-2',
            key: 'equipment:propulsion:coupling_ps',
            category: 'equipment',
            subcategory: 'propulsion',
            item: 'coupling_ps',
            description: 'Port coupling.',
          },
        },
      ]),
    };
    const prisma = {
      shipManual: {
        findFirst: jest.fn().mockResolvedValue({ id: 'manual-1' }),
      },
      tag: {
        findMany: jest.fn().mockResolvedValue([{ id: 'tag-1' }, { id: 'tag-2' }]),
      },
      shipManualTag,
      $transaction: jest.fn().mockImplementation(async (callback) =>
        callback({ shipManualTag }),
      ),
    };
    const service = new TagLinksService(prisma as never, {} as never);

    const result = await service.replaceManualTags('ship-1', 'manual-1', [
      'tag-1',
      'tag-2',
    ]);

    expect(shipManualTag.createMany).toHaveBeenCalledWith({
      data: [
        { shipManualId: 'manual-1', tagId: 'tag-1' },
        { shipManualId: 'manual-1', tagId: 'tag-2' },
      ],
      skipDuplicates: true,
    });
    expect(result.map((tag) => tag.id)).toEqual(['tag-1', 'tag-2']);
  });

  it('infers storage tank scope for generic stored-fluid inventory queries', async () => {
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'fuel-storage',
            key: 'equipment:fuel:storage_tank',
            category: 'equipment',
            subcategory: 'fuel',
            item: 'storage_tank',
            description: 'Fuel storage tank.',
          },
        ]),
      },
      metricDefinitionTag: {
        findMany: jest.fn().mockResolvedValue([
          { metricKey: 'metric-1' },
          { metricKey: 'metric-2' },
        ]),
      },
      shipMetricsConfig: {
        findMany: jest.fn().mockResolvedValue([
          { metricKey: 'metric-1' },
          { metricKey: 'metric-2' },
        ]),
      },
    };
    const service = new TagLinksService(
      prisma as never,
      new TagMatcherService(),
    );

    const result = await service.findTaggedMetricKeysForShipQuery(
      'ship-1',
      'what the fuel level',
    );

    expect(prisma.metricDefinitionTag.findMany).toHaveBeenCalledWith({
      where: { tagId: { in: ['fuel-storage'] } },
      select: { metricKey: true },
    });
    expect(result).toEqual(['metric-1', 'metric-2']);
  });

  it('rebuilds links conservatively by default without replacing curated links', async () => {
    const prisma = {
      metricDefinition: {
        findMany: jest.fn().mockResolvedValue([{ key: 'metric-1' }]),
      },
      shipManual: {
        findMany: jest.fn().mockResolvedValue([{ id: 'manual-1' }]),
      },
    };
    const service = new TagLinksService(prisma as never, {} as never);
    const autoLinkMetrics = jest
      .spyOn(service, 'autoLinkMetrics')
      .mockResolvedValue({
        processed: 1,
        linked: 1,
        untouched: 0,
        cleared: 0,
      });
    const autoLinkManuals = jest
      .spyOn(service, 'autoLinkManuals')
      .mockResolvedValue({
        processed: 1,
        linked: 0,
        untouched: 1,
        cleared: 0,
      });

    const result = await service.rebuildLinks();

    expect(autoLinkMetrics).toHaveBeenCalledWith(['metric-1'], {
      replaceExisting: false,
    });
    expect(autoLinkManuals).toHaveBeenCalledWith(['manual-1'], {
      replaceExisting: false,
    });
    expect(result.replaceExisting).toBe(false);
  });

  it('can rebuild links in replace mode when explicitly requested', async () => {
    const prisma = {
      metricDefinition: {
        findMany: jest.fn().mockResolvedValue([{ key: 'metric-1' }]),
      },
      shipManual: {
        findMany: jest.fn().mockResolvedValue([{ id: 'manual-1' }]),
      },
    };
    const service = new TagLinksService(prisma as never, {} as never);
    const autoLinkMetrics = jest
      .spyOn(service, 'autoLinkMetrics')
      .mockResolvedValue({
        processed: 1,
        linked: 1,
        untouched: 0,
        cleared: 0,
      });
    const autoLinkManuals = jest
      .spyOn(service, 'autoLinkManuals')
      .mockResolvedValue({
        processed: 1,
        linked: 1,
        untouched: 0,
        cleared: 0,
      });

    const result = await service.rebuildLinks({ replaceExisting: true });

    expect(autoLinkMetrics).toHaveBeenCalledWith(['metric-1'], {
      replaceExisting: true,
    });
    expect(autoLinkManuals).toHaveBeenCalledWith(['manual-1'], {
      replaceExisting: true,
    });
    expect(result.replaceExisting).toBe(true);
  });

  it('prefers field-level metric matches over noisy group labels during auto-linking', async () => {
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bilge-alarm',
            key: 'equipment:bilge:alarm',
            category: 'equipment',
            subcategory: 'bilge',
            item: 'alarm',
            description: 'Bilge alarm.',
          },
          {
            id: 'bilge-pump',
            key: 'equipment:bilge:pump',
            category: 'equipment',
            subcategory: 'bilge',
            item: 'pump',
            description: 'Bilge pump.',
          },
        ]),
      },
      metricDefinition: {
        findMany: jest.fn().mockResolvedValue([
          {
            key: 'metric-1',
            label: 'PORT FORE BILGE PUMP SPY',
            description: null,
            unit: null,
            bucket: 'Trending',
            measurement: 'Bilge-Alarms2',
            field: 'PORT FORE BILGE PUMP SPY',
            tags: [],
          },
        ]),
      },
      metricDefinitionTag: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new TagLinksService(
      prisma as never,
      new TagMatcherService(),
    );

    await service.autoLinkMetrics(['metric-1']);

    expect(prisma.metricDefinitionTag.createMany).toHaveBeenCalledWith({
      data: [{ metricKey: 'metric-1', tagId: 'bilge-pump' }],
      skipDuplicates: true,
    });
  });

  it('leaves described metrics untagged when only a noisy fallback tag is available', async () => {
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bilge-alarm',
            key: 'equipment:bilge:alarm',
            category: 'equipment',
            subcategory: 'bilge',
            item: 'alarm',
            description: 'Bilge alarm.',
          },
        ]),
      },
      metricDefinition: {
        findMany: jest.fn().mockResolvedValue([
          {
            key: 'metric-1',
            label: 'Bilge-Alarms2.PORT FORE BILGE PUMP SPY',
            description:
              'Indicates activity or signal from the port fore bilge pump monitoring point.',
            unit: null,
            bucket: 'Trending',
            measurement: 'Bilge-Alarms2',
            field: 'PORT FORE BILGE PUMP SPY',
            tags: [],
          },
        ]),
      },
      metricDefinitionTag: {
        createMany: jest.fn(),
      },
    };
    const service = new TagLinksService(
      prisma as never,
      new TagMatcherService(),
    );

    const result = await service.autoLinkMetrics(['metric-1']);

    expect(prisma.metricDefinitionTag.createMany).not.toHaveBeenCalled();
    expect(result.linked).toBe(0);
  });

  it('stores only the highest-ranked auto-link match for each metric', async () => {
    const matcher = {
      buildProfiles: jest.fn().mockImplementation((tags) =>
        tags.map((tag: { id: string }) => ({
          tag: { id: tag.id },
        })),
      ),
      matchTags: jest.fn().mockReturnValue([
        { tagId: 'fuel-storage', score: 14 },
        { tagId: 'fuel-day', score: 13 },
      ]),
    };
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'fuel-storage',
            key: 'equipment:fuel:storage_tank',
            category: 'equipment',
            subcategory: 'fuel',
            item: 'storage_tank',
            description: 'Main fuel storage tank.',
          },
          {
            id: 'fuel-day',
            key: 'equipment:fuel:day_tank',
            category: 'equipment',
            subcategory: 'fuel',
            item: 'day_tank',
            description: 'Fuel day tank.',
          },
        ]),
      },
      metricDefinition: {
        findMany: jest.fn().mockResolvedValue([
          {
            key: 'metric-1',
            label: 'Fuel Tank 1',
            description: null,
            unit: null,
            bucket: 'Trending',
            measurement: 'Tanks',
            field: 'Fuel_Tank_1P',
            tags: [],
          },
        ]),
      },
      metricDefinitionTag: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new TagLinksService(prisma as never, matcher as never);

    await service.autoLinkMetrics(['metric-1']);

    expect(prisma.metricDefinitionTag.createMany).toHaveBeenCalledWith({
      data: [{ metricKey: 'metric-1', tagId: 'fuel-storage' }],
      skipDuplicates: true,
    });
  });

  it('uses parsed document chunks to choose a stronger primary tag for manuals', async () => {
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'generator-ps',
            key: 'equipment:electrical:generator_ps',
            category: 'equipment',
            subcategory: 'electrical',
            item: 'generator_ps',
            description: 'Port generator.',
          },
          {
            id: 'fuel-storage',
            key: 'equipment:fuel:storage_tank',
            category: 'equipment',
            subcategory: 'fuel',
            item: 'storage_tank',
            description: 'Fuel tank.',
          },
        ]),
      },
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-1',
            filename: 'Operators Manual.pdf',
            category: 'MANUALS',
            ragflowDocumentId: 'doc-1',
            ship: {
              ragflowDatasetId: 'dataset-1',
            },
            tags: [],
          },
        ]),
      },
      shipManualTag: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest.fn().mockResolvedValue([
        {
          content:
            'Port generator maintenance checklist. Port generator cooling inspection and port generator filter replacement.',
        },
        {
          content:
            'Port side generator service interval. Generator running hours and electrical generator shutdown procedure.',
        },
        {
          content:
            'Fuel tank calibration appears in a separate appendix for the vessel display configuration.',
        },
      ]),
    };
    const service = new TagLinksService(
      prisma as never,
      new TagMatcherService(),
      ragflow as never,
    );

    await service.autoLinkManuals(['manual-1']);

    expect(prisma.shipManualTag.createMany).toHaveBeenCalledWith({
      data: [{ shipManualId: 'manual-1', tagId: 'generator-ps' }],
      skipDuplicates: true,
    });
  });

  it('falls back to filename-based manual tagging when parsed content is unavailable', async () => {
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bilge-pump',
            key: 'equipment:bilge:pump',
            category: 'equipment',
            subcategory: 'bilge',
            item: 'pump',
            description: 'Bilge pump.',
          },
        ]),
      },
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-1',
            filename: 'Bilge Pump Procedures.pdf',
            category: 'MANUALS',
            ragflowDocumentId: 'doc-1',
            ship: {
              ragflowDatasetId: 'dataset-1',
            },
            tags: [],
          },
        ]),
      },
      shipManualTag: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest.fn().mockRejectedValue(new Error('not ready')),
    };
    const service = new TagLinksService(
      prisma as never,
      new TagMatcherService(),
      ragflow as never,
    );

    await service.autoLinkManuals(['manual-1']);

    expect(prisma.shipManualTag.createMany).toHaveBeenCalledWith({
      data: [{ shipManualId: 'manual-1', tagId: 'bilge-pump' }],
      skipDuplicates: true,
    });
  });

  it('prefers semantic-profile concept tags over noisy chunk-only matches for manuals', async () => {
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bilge-pump-emergency',
            key: 'equipment:bilge:pump_emergency',
            category: 'equipment',
            subcategory: 'bilge',
            item: 'pump_emergency',
            description: 'Emergency diesel-driven bilge and fire pump.',
          },
          {
            id: 'shaft-ps',
            key: 'equipment:propulsion:shaft_ps',
            category: 'equipment',
            subcategory: 'propulsion',
            item: 'shaft_ps',
            description:
              'Port side propeller shaft, shaft seal, and associated bearings.',
          },
        ]),
      },
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-1',
            filename: 'OEM pump manual.pdf',
            category: 'MANUALS',
            ragflowDocumentId: 'doc-1',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'operational_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: ['tag:equipment:bilge:pump_emergency'],
              secondaryConceptIds: [],
              systems: ['bilge system'],
              equipment: ['emergency bilge pump'],
              vendor: 'Gianneschi',
              model: 'MACB531',
              aliases: ['Emergency Bilge Pump'],
              summary: 'Manual for an emergency bilge pump.',
              sections: [],
              pageTopics: [],
            },
            ship: {
              ragflowDatasetId: 'dataset-1',
            },
            tags: [],
          },
        ]),
      },
      shipManualTag: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest.fn().mockResolvedValue([
        {
          content:
            'Unpack the pump and check that the shaft turns freely before use.',
        },
      ]),
    };
    const service = new TagLinksService(
      prisma as never,
      new TagMatcherService(),
      ragflow as never,
    );

    await service.autoLinkManuals(['manual-1']);

    expect(prisma.shipManualTag.createMany).toHaveBeenCalledWith({
      data: [{ shipManualId: 'manual-1', tagId: 'bilge-pump-emergency' }],
      skipDuplicates: true,
    });
  });

  it('can infer an emergency bilge pump tag from semantic profile text for a generic OEM manual', async () => {
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bilge-pump-emergency',
            key: 'equipment:bilge:pump_emergency',
            category: 'equipment',
            subcategory: 'bilge',
            item: 'pump_emergency',
            description: 'Emergency diesel-driven bilge and fire pump.',
          },
          {
            id: 'shaft-ps',
            key: 'equipment:propulsion:shaft_ps',
            category: 'equipment',
            subcategory: 'propulsion',
            item: 'shaft_ps',
            description:
              'Port side propeller shaft, shaft seal, and associated bearings.',
          },
        ]),
      },
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-1',
            filename: 'OEM pump manual.pdf',
            category: 'MANUALS',
            ragflowDocumentId: 'doc-1',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'operational_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [],
              secondaryConceptIds: ['spare_parts_catalog'],
              systems: ['bilge pumping', 'fire-fighting', 'diesel transfer'],
              equipment: ['centrifugal self-priming pump', 'diesel engine'],
              vendor: 'Gianneschi',
              model: 'MACB531',
              aliases: ['MACB 531'],
              summary:
                'Operating manual for a diesel-driven self-priming pump used for bilge, fire-fighting and transfer duties.',
              sections: [
                {
                  title: 'Diesel Engine Maintenance',
                  pageStart: 9,
                  pageEnd: 9,
                  conceptIds: [],
                  sectionType: 'checklist',
                  summary:
                    'Cold-engine maintenance intervals for oil, air cleaner, oil filter, fuel filter and cooling fins.',
                },
              ],
              pageTopics: [],
            },
            ship: {
              ragflowDatasetId: 'dataset-1',
            },
            tags: [],
          },
        ]),
      },
      shipManualTag: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest.fn().mockResolvedValue([
        {
          content:
            'This booklet describes the operating procedures for MACB 531 series el/pump. Most common uses are: Bilge, Diesel and Oil Transfer, Fire-Fighting.',
        },
      ]),
    };
    const service = new TagLinksService(
      prisma as never,
      new TagMatcherService(),
      ragflow as never,
    );

    await service.autoLinkManuals(['manual-1']);

    expect(prisma.shipManualTag.createMany).toHaveBeenCalledWith({
      data: [{ shipManualId: 'manual-1', tagId: 'bilge-pump-emergency' }],
      skipDuplicates: true,
    });
  });

  it('does not let noisy primary concepts override stronger equipment-role evidence', async () => {
    const prisma = {
      tag: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'bilge-pump-emergency',
            key: 'equipment:bilge:pump_emergency',
            category: 'equipment',
            subcategory: 'bilge',
            item: 'pump_emergency',
            description: 'Emergency diesel-driven bilge and fire pump.',
          },
          {
            id: 'fire-pump',
            key: 'equipment:fire:pump',
            category: 'equipment',
            subcategory: 'fire',
            item: 'pump',
            description: 'Fire-fighting pump.',
          },
          {
            id: 'water-tank',
            key: 'equipment:water:tank',
            category: 'equipment',
            subcategory: 'water',
            item: 'tank',
            description: 'Fresh water tank.',
          },
        ]),
      },
      shipManual: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'manual-1',
            filename: 'MN_MACB531.pdf',
            category: 'MANUALS',
            ragflowDocumentId: 'doc-1',
            semanticProfile: {
              schemaVersion: '2026-04-06.semantic-v2',
              documentType: 'operational_procedure',
              sourceCategory: 'MANUALS',
              primaryConceptIds: [
                'spare_parts_catalog',
                'regulatory_compliance',
                'tag:equipment:fire:pump',
                'tag:equipment:water:tank',
              ],
              secondaryConceptIds: ['spare_parts_catalog'],
              systems: [
                'sea water transfer',
                'fresh water transfer',
                'diesel transfer',
                'bilge pumping',
                'fire-fighting',
                'grey water',
              ],
              equipment: [
                'centrifugal self-priming pump',
                'diesel engine',
                'mechanical seal',
                'impeller',
                'bearings',
              ],
              vendor: 'Gianneschi',
              model: 'MACB531',
              aliases: [
                'MACB 531',
                'centrifugal self-priming pumps',
                'elettropompe serie MACB 531',
                'motopompe MACB 531',
                'Lombardini 15LD500',
              ],
              summary:
                'Operating and maintenance manual for Gianneschi MACB531 self-priming centrifugal pumps, with installation, starting, maintenance, spare parts and overhaul steps.',
              sections: [
                {
                  title: 'Pump Maintenance',
                  pageStart: 9,
                  pageEnd: 10,
                  conceptIds: [],
                  sectionType: 'checklist',
                  summary:
                    'Service intervals cover pump body inspection, seal replacement, fuel filter checks and diesel-engine maintenance.',
                },
              ],
              pageTopics: [],
            },
            ship: {
              ragflowDatasetId: 'dataset-1',
            },
            tags: [],
          },
        ]),
      },
      shipManualTag: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const ragflow = {
      isConfigured: jest.fn().mockReturnValue(true),
      listDocumentChunks: jest.fn().mockResolvedValue([]),
    };
    const service = new TagLinksService(
      prisma as never,
      new TagMatcherService(),
      ragflow as never,
    );

    await service.autoLinkManuals(['manual-1']);

    expect(prisma.shipManualTag.createMany).toHaveBeenCalled();
    const createManyArg = prisma.shipManualTag.createMany.mock.calls[0][0];
    expect(createManyArg.skipDuplicates).toBe(true);
    expect(createManyArg.data).toEqual(
      expect.arrayContaining([
        { shipManualId: 'manual-1', tagId: 'bilge-pump-emergency' },
      ]),
    );
  });
});
