import { BadRequestException, ConflictException } from '@nestjs/common';
import { TagsService } from './tags.service';

function createPrismaMock() {
  const prisma = {
    tag: {
      count: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
      upsert: jest.fn(),
      groupBy: jest.fn(),
    },
    metricDefinitionTag: {
      count: jest.fn(),
    },
    shipManualTag: {
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  prisma.$transaction.mockImplementation(async (callback: unknown) => {
    if (typeof callback === 'function') {
      return callback(prisma);
    }

    return null;
  });

  return prisma;
}

describe('TagsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: TagsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new TagsService(prisma as never);
  });

  it('creates a tag using a canonical key derived from segments', async () => {
    prisma.tag.findUnique.mockResolvedValueOnce(null);
    prisma.tag.create.mockResolvedValueOnce({
      id: 'tag_1',
      key: 'equipment:propulsion:main_engine_ps',
      category: 'equipment',
      subcategory: 'propulsion',
      item: 'main_engine_ps',
      description: 'Main engine',
      createdAt: new Date('2026-04-02T10:00:00.000Z'),
      updatedAt: new Date('2026-04-02T10:00:00.000Z'),
      _count: {
        metricLinks: 0,
        manualLinks: 0,
      },
    });

    const result = await service.create({
      category: 'Equipment',
      subcategory: 'Propulsion',
      item: 'Main Engine PS',
      description: 'Main engine',
    });

    expect(prisma.tag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: 'equipment:propulsion:main_engine_ps',
          category: 'equipment',
          subcategory: 'propulsion',
          item: 'main_engine_ps',
        }),
      }),
    );
    expect(result.key).toBe('equipment:propulsion:main_engine_ps');
  });

  it('creates a tag without subcategory using a two-part canonical key', async () => {
    prisma.tag.findUnique.mockResolvedValueOnce(null);
    prisma.tag.create.mockResolvedValueOnce({
      id: 'tag_2',
      key: 'equipment:multiplexer',
      category: 'equipment',
      subcategory: '',
      item: 'multiplexer',
      description: 'Bridge multiplexer',
      createdAt: new Date('2026-04-02T10:00:00.000Z'),
      updatedAt: new Date('2026-04-02T10:00:00.000Z'),
      _count: {
        metricLinks: 0,
        manualLinks: 0,
      },
    });

    const result = await service.create({
      category: 'Equipment',
      item: 'Multiplexer',
      description: 'Bridge multiplexer',
    });

    expect(prisma.tag.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          key: 'equipment:multiplexer',
          category: 'equipment',
          subcategory: '',
          item: 'multiplexer',
        }),
      }),
    );
    expect(result.key).toBe('equipment:multiplexer');
    expect(result.subcategory).toBe('');
  });

  it('prevents updating a tag into an already used canonical key', async () => {
    prisma.tag.findUnique
      .mockResolvedValueOnce({
        id: 'tag_current',
        category: 'equipment',
        subcategory: 'propulsion',
        item: 'gearbox_ps',
        description: null,
      })
      .mockResolvedValueOnce({ id: 'tag_other' });

    await expect(
      service.update('tag_current', {
        category: 'equipment',
        subcategory: 'propulsion',
        item: 'main_engine_ps',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns a paginated tag list with summary metadata', async () => {
    prisma.tag.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    prisma.metricDefinitionTag.count.mockResolvedValueOnce(7);
    prisma.shipManualTag.count.mockResolvedValueOnce(5);
    prisma.tag.groupBy
      .mockResolvedValueOnce([
        { category: 'equipment' },
        { category: 'safety' },
      ])
      .mockResolvedValueOnce([{ subcategory: 'propulsion' }]);
    prisma.tag.findMany.mockResolvedValueOnce([
      {
        id: 'tag_1',
        key: 'equipment:propulsion:main_engine_ps',
        category: 'equipment',
        subcategory: 'propulsion',
        item: 'main_engine_ps',
        description: 'Main engine',
        createdAt: new Date('2026-04-02T10:00:00.000Z'),
        updatedAt: new Date('2026-04-02T10:00:00.000Z'),
        _count: {
          metricLinks: 3,
          manualLinks: 1,
        },
      },
    ]);

    const result = await service.findAll({
      page: 2,
      pageSize: 25,
      category: 'equipment',
    });

    expect(prisma.tag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 0,
        take: 25,
      }),
    );
    expect(result.pagination.total).toBe(1);
    expect(result.summary.totalTags).toBe(2);
    expect(result.summary.metricLinks).toBe(7);
    expect(result.filters.categoryOptions).toEqual(['equipment', 'safety']);
    expect(result.filters.subcategoryOptions).toEqual(['propulsion']);
  });

  it('imports a two-segment taxonomy tag without requiring subcategory', async () => {
    prisma.tag.findMany.mockResolvedValueOnce([]);
    prisma.tag.upsert.mockResolvedValue(null);

    const result = await service.importTaxonomy({
      originalname: 'tags.json',
      mimetype: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          tags: [
            {
              tag: 'equipment:multiplexer',
              description: 'Bridge multiplexer',
            },
          ],
        }),
      ),
    });

    expect(prisma.tag.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'equipment:multiplexer' },
        create: expect.objectContaining({
          key: 'equipment:multiplexer',
          category: 'equipment',
          subcategory: '',
          item: 'multiplexer',
        }),
        update: expect.objectContaining({
          category: 'equipment',
          subcategory: '',
          item: 'multiplexer',
        }),
      }),
    );
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('imports taxonomy entries idempotently and warns about mismatched source tags', async () => {
    prisma.tag.findMany.mockResolvedValueOnce([
      { id: 'existing_tag', key: 'equipment:propulsion:main_engine_sb' },
    ]);
    prisma.tag.upsert.mockResolvedValue(null);

    const result = await service.importTaxonomy({
      originalname: 'tags.json',
      mimetype: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          tags: [
            {
              tag: 'equipment:propulsion:main_engine_ps',
              category: 'equipment',
              subcategory: 'propulsion',
              item: 'main_propulsion_motor_ps',
              description: 'Port side motor',
            },
            {
              tag: 'equipment:propulsion:main_engine_sb',
              category: 'equipment',
              subcategory: 'propulsion',
              item: 'main_engine_sb',
              description: 'Starboard engine',
            },
          ],
        }),
      ),
    });

    expect(prisma.tag.upsert).toHaveBeenCalledTimes(2);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.warningCount).toBe(1);
    expect(result.warnings[0]).toContain('main_engine_ps');
    expect(result.warnings[0]).toContain('main_propulsion_motor_ps');
  });

  it('rejects non-json imports', async () => {
    await expect(
      service.importTaxonomy({
        originalname: 'tags.txt',
        mimetype: 'text/csv',
        buffer: Buffer.from('[]'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('bulk deletes selected tags by id', async () => {
    prisma.tag.findMany.mockResolvedValueOnce([
      { id: 'tag_1' },
      { id: 'tag_2' },
    ]);
    prisma.tag.deleteMany.mockResolvedValueOnce({ count: 2 });

    const result = await service.bulkRemove({
      mode: 'tagIds',
      tagIds: ['tag_1', 'tag_2', 'tag_1'],
    });

    expect(prisma.tag.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          AND: [{ id: { in: ['tag_1', 'tag_2'] } }],
        },
      }),
    );
    expect(prisma.tag.deleteMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['tag_1', 'tag_2'] },
      },
    });
    expect(result).toEqual({ deletedCount: 2 });
  });
});
