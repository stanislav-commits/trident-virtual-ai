import {
  Optional,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BulkRemoveTagsDto } from './dto/bulk-remove-tags.dto';
import { CreateTagDto } from './dto/create-tag.dto';
import { RebuildTagLinksDto } from './dto/rebuild-tag-links.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { TagLinksService } from './tag-links.service';

const TAG_SELECT = {
  id: true,
  key: true,
  category: true,
  subcategory: true,
  item: true,
  description: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      metricLinks: true,
      manualLinks: true,
    },
  },
} satisfies Prisma.TagSelect;

type TagRecord = Prisma.TagGetPayload<{ select: typeof TAG_SELECT }>;

export interface TagListItemResponse {
  id: string;
  key: string;
  category: string;
  subcategory: string;
  item: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  metricLinksCount: number;
  manualLinksCount: number;
}

export interface TagsPaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PaginatedTagsResult {
  items: TagListItemResponse[];
  pagination: TagsPaginationMeta;
  filters: {
    categoryOptions: string[];
    subcategoryOptions: string[];
  };
  summary: {
    totalTags: number;
    filteredTags: number;
    categories: number;
    metricLinks: number;
    manualLinks: number;
  };
}

type FindAllTagsFilters = {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: string;
  subcategory?: string;
  includeTagIds?: string[];
  excludeTagIds?: string[];
};

type NormalizedTagInput = {
  key: string;
  category: string;
  subcategory: string;
  item: string;
  description: string | null;
};

type ImportTaxonomyFile = {
  buffer: Buffer;
  originalname?: string;
  mimetype?: string;
};

type TaxonomyTagRecord = {
  tag?: unknown;
  category?: unknown;
  subcategory?: unknown;
  item?: unknown;
  description?: unknown;
};

type ImportedTagEntry = NormalizedTagInput & {
  sourceTag: string | null;
  sourceIndex: number;
};

type ParsedTaxonomyDocument = {
  tags?: unknown;
};

@Injectable()
export class TagsService {
  private readonly defaultPageSize = 25;
  private readonly maxPageSize = 100;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly tagLinks?: TagLinksService,
  ) {}

  async findAll(filters: FindAllTagsFilters = {}): Promise<PaginatedTagsResult> {
    const pagination = this.normalizePagination(filters.page, filters.pageSize);
    const where = this.buildWhereClause(filters);
    const normalizedCategory = this.normalizeFilterValue(filters.category);
    const [filteredTotal, totalTags, metricLinks, manualLinks, categoryRows] =
      await Promise.all([
        this.prisma.tag.count({ where }),
        this.prisma.tag.count(),
        this.prisma.metricDefinitionTag.count(),
        this.prisma.shipManualTag.count(),
        this.prisma.tag.groupBy({
          by: ['category'],
          orderBy: { category: 'asc' },
        }),
      ]);

    const meta = this.buildPaginationMeta(
      filteredTotal,
      pagination.page,
      pagination.pageSize,
    );

    const [tags, subcategoryRows] = await Promise.all([
      this.prisma.tag.findMany({
        where,
        orderBy: [{ category: 'asc' }, { subcategory: 'asc' }, { item: 'asc' }],
        skip: (meta.page - 1) * meta.pageSize,
        take: meta.pageSize,
        select: TAG_SELECT,
      }),
      this.prisma.tag.groupBy({
        by: ['subcategory'],
        ...(normalizedCategory
          ? { where: { category: normalizedCategory } }
          : {}),
        orderBy: { subcategory: 'asc' },
      }),
    ]);

    return {
      items: tags.map((tag) => this.toTagResponse(tag)),
      pagination: meta,
      filters: {
        categoryOptions: categoryRows.map((row) => row.category),
        subcategoryOptions: subcategoryRows.map((row) => row.subcategory),
      },
      summary: {
        totalTags,
        filteredTags: filteredTotal,
        categories: categoryRows.length,
        metricLinks,
        manualLinks,
      },
    };
  }

  async findOne(id: string) {
    const tag = await this.prisma.tag.findUnique({
      where: { id },
      select: TAG_SELECT,
    });

    if (!tag) {
      throw new NotFoundException('Tag not found');
    }

    return this.toTagResponse(tag);
  }

  async listOptions() {
    return (
      this.tagLinks?.listTagOptions() ??
      this.prisma.tag.findMany({
        orderBy: [{ category: 'asc' }, { subcategory: 'asc' }, { item: 'asc' }],
        select: {
          id: true,
          key: true,
          category: true,
          subcategory: true,
          item: true,
          description: true,
        },
      })
    );
  }

  async create(dto: CreateTagDto) {
    const normalized = this.normalizeTagInput(dto);
    const existing = await this.prisma.tag.findUnique({
      where: { key: normalized.key },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException(
        `Tag with key "${normalized.key}" already exists`,
      );
    }

    const created = await this.prisma.tag.create({
      data: normalized,
      select: TAG_SELECT,
    });
    this.tagLinks?.invalidateTagCache();

    return this.toTagResponse(created);
  }

  async update(id: string, dto: UpdateTagDto) {
    const current = await this.prisma.tag.findUnique({
      where: { id },
      select: {
        id: true,
        category: true,
        subcategory: true,
        item: true,
        description: true,
      },
    });

    if (!current) {
      throw new NotFoundException('Tag not found');
    }

    const normalized = this.normalizeTagInput({
      category: dto.category ?? current.category,
      subcategory: dto.subcategory ?? current.subcategory,
      item: dto.item ?? current.item,
      description:
        dto.description !== undefined ? dto.description : current.description,
    });

    const duplicate =
      normalized.key !==
      this.buildCanonicalKey(
        current.category,
        current.subcategory,
        current.item,
      )
        ? await this.prisma.tag.findUnique({
            where: { key: normalized.key },
            select: { id: true },
          })
        : null;

    if (duplicate && duplicate.id !== id) {
      throw new ConflictException(
        `Tag with key "${normalized.key}" already exists`,
      );
    }

    const updated = await this.prisma.tag.update({
      where: { id },
      data: normalized,
      select: TAG_SELECT,
    });
    this.tagLinks?.invalidateTagCache();

    return this.toTagResponse(updated);
  }

  async remove(id: string) {
    const existing = await this.prisma.tag.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('Tag not found');
    }

    await this.prisma.tag.delete({ where: { id } });
    this.tagLinks?.invalidateTagCache();
  }

  async bulkRemove(dto: BulkRemoveTagsDto) {
    const mode = dto.mode === 'all' ? 'all' : 'tagIds';
    const tagIds = this.normalizeTagIds(dto.tagIds);
    const excludeTagIds = this.normalizeTagIds(dto.excludeTagIds);

    if (mode === 'tagIds' && tagIds.length === 0) {
      throw new BadRequestException('No tags selected');
    }

    const matchingTags = await this.prisma.tag.findMany({
      where:
        mode === 'all'
          ? this.buildWhereClause({
              search: dto.search,
              category: dto.category,
              subcategory: dto.subcategory,
              excludeTagIds,
            })
          : this.buildWhereClause({
              includeTagIds: tagIds,
            }),
      select: { id: true },
    });

    if (!matchingTags.length) {
      return { deletedCount: 0 };
    }

    const deleted = await this.prisma.tag.deleteMany({
      where: {
        id: { in: matchingTags.map((tag) => tag.id) },
      },
    });
    if (deleted.count > 0) {
      this.tagLinks?.invalidateTagCache();
    }

    return { deletedCount: deleted.count };
  }

  async importTaxonomy(file: ImportTaxonomyFile) {
    this.assertJsonFile(file);

    let parsed: ParsedTaxonomyDocument | TaxonomyTagRecord[];
    try {
      parsed = JSON.parse(file.buffer.toString('utf8')) as
        | ParsedTaxonomyDocument
        | TaxonomyTagRecord[];
    } catch {
      throw new BadRequestException('Invalid JSON file');
    }

    const sourceTags = Array.isArray(parsed) ? parsed : parsed?.tags;
    if (!Array.isArray(sourceTags)) {
      throw new BadRequestException(
        'JSON must contain a top-level "tags" array',
      );
    }

    if (sourceTags.length === 0) {
      throw new BadRequestException('JSON file does not contain any tags');
    }

    const warnings: string[] = [];
    const entriesByKey = new Map<string, ImportedTagEntry>();

    sourceTags.forEach((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException(
          `Tag entry ${index + 1} must be an object`,
        );
      }

      const entry = value as TaxonomyTagRecord;
      const normalized = this.normalizeTagInput(entry);
      const sourceTag = this.normalizeSourceTag(entry.tag);

      if (sourceTag && sourceTag !== normalized.key) {
        warnings.push(
          `Entry ${index + 1} used source tag "${sourceTag}", imported as "${normalized.key}".`,
        );
      }

      if (entriesByKey.has(normalized.key)) {
        warnings.push(
          `Duplicate tag "${normalized.key}" found in the file; the last occurrence was used.`,
        );
      }

      entriesByKey.set(normalized.key, {
        ...normalized,
        sourceTag,
        sourceIndex: index,
      });
    });

    const importedEntries = [...entriesByKey.values()].sort(
      (left, right) => left.sourceIndex - right.sourceIndex,
    );
    const importedKeys = importedEntries.map((entry) => entry.key);
    const existingTags = await this.prisma.tag.findMany({
      where: { key: { in: importedKeys } },
      select: { id: true, key: true },
    });
    const existingKeys = new Set(existingTags.map((tag) => tag.key));

    await this.prisma.$transaction(async (tx) => {
      for (const entry of importedEntries) {
        await tx.tag.upsert({
          where: { key: entry.key },
          create: {
            key: entry.key,
            category: entry.category,
            subcategory: entry.subcategory,
            item: entry.item,
            description: entry.description,
          },
          update: {
            category: entry.category,
            subcategory: entry.subcategory,
            item: entry.item,
            description: entry.description,
          },
        });
      }
    });

    const created = importedEntries.filter(
      (entry) => !existingKeys.has(entry.key),
    ).length;
    const updated = importedEntries.length - created;
    this.tagLinks?.invalidateTagCache();

    return {
      sourceEntries: sourceTags.length,
      uniqueTags: importedEntries.length,
      created,
      updated,
      warnings,
      warningCount: warnings.length,
    };
  }

  async rebuildLinks(dto: RebuildTagLinksDto) {
    if (!this.tagLinks) {
      return {
        scope: dto.scope ?? 'all',
        metrics: { processed: 0, linked: 0, untouched: 0, cleared: 0 },
        manuals: { processed: 0, linked: 0, untouched: 0, cleared: 0 },
      };
    }

    return this.tagLinks.rebuildLinks({
      scope: dto.scope,
      shipId: dto.shipId,
    });
  }

  private buildWhereClause(filters: FindAllTagsFilters): Prisma.TagWhereInput {
    const clauses: Prisma.TagWhereInput[] = [];
    const search = filters.search?.trim();
    const category = this.normalizeFilterValue(filters.category);
    const subcategory = this.normalizeFilterValue(filters.subcategory);
    const includeTagIds = this.normalizeTagIds(filters.includeTagIds);
    const excludeTagIds = this.normalizeTagIds(filters.excludeTagIds);

    if (category) {
      clauses.push({ category });
    }

    if (subcategory) {
      clauses.push({ subcategory });
    }

    if (search) {
      clauses.push({
        OR: [
          { key: { contains: search, mode: 'insensitive' } },
          { category: { contains: search, mode: 'insensitive' } },
          { subcategory: { contains: search, mode: 'insensitive' } },
          { item: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    if (includeTagIds.length) {
      clauses.push({ id: { in: includeTagIds } });
    }

    if (excludeTagIds.length) {
      clauses.push({ id: { notIn: excludeTagIds } });
    }

    if (clauses.length === 0) {
      return {};
    }

    return { AND: clauses };
  }

  private normalizePagination(page?: number, pageSize?: number) {
    const normalizedPage = Number.isFinite(page)
      ? Math.max(1, Math.floor(page as number))
      : 1;
    const normalizedPageSize = Number.isFinite(pageSize)
      ? Math.max(1, Math.min(Math.floor(pageSize as number), this.maxPageSize))
      : this.defaultPageSize;

    return {
      page: normalizedPage,
      pageSize: normalizedPageSize,
    };
  }

  private buildPaginationMeta(
    total: number,
    page: number,
    pageSize: number,
  ): TagsPaginationMeta {
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
    const currentPage = Math.min(page, totalPages);

    return {
      page: currentPage,
      pageSize,
      total,
      totalPages,
      hasNextPage: currentPage < totalPages,
      hasPreviousPage: currentPage > 1,
    };
  }

  private normalizeTagIds(ids?: string[]): string[] {
    if (!ids?.length) return [];
    return [...new Set(ids.map((id) => id?.trim()).filter(Boolean))];
  }

  private normalizeFilterValue(value?: string): string | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized ? normalized : undefined;
  }

  private normalizeTagInput(input: {
    category?: unknown;
    subcategory?: unknown;
    item?: unknown;
    description?: unknown;
  }): NormalizedTagInput {
    const category = this.normalizeSegment(input.category, 'category', 100);
    const subcategory = this.normalizeSegment(
      input.subcategory,
      'subcategory',
      100,
    );
    const item = this.normalizeSegment(input.item, 'item', 150);
    const description = this.normalizeDescription(input.description);

    return {
      key: this.buildCanonicalKey(category, subcategory, item),
      category,
      subcategory,
      item,
      description,
    };
  }

  private normalizeSegment(
    value: unknown,
    fieldName: string,
    maxLength: number,
  ): string {
    if (typeof value === 'object' && value !== null) {
      throw new BadRequestException(`${fieldName} must be a string`);
    }

    const raw = String(value ?? '').trim();
    if (!raw) {
      throw new BadRequestException(`${fieldName} is required`);
    }

    if (raw.includes(':')) {
      throw new BadRequestException(
        `${fieldName} must not contain ":" characters`,
      );
    }

    const normalized = raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');

    if (!normalized) {
      throw new BadRequestException(`${fieldName} is invalid`);
    }

    if (normalized.length > maxLength) {
      throw new BadRequestException(
        `${fieldName} must be ${maxLength} characters or fewer`,
      );
    }

    return normalized;
  }

  private normalizeDescription(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value === 'object') {
      throw new BadRequestException('description must be a string');
    }

    const normalized = String(value).trim();
    if (!normalized) {
      return null;
    }

    if (normalized.length > 5000) {
      throw new BadRequestException(
        'description must be 5000 characters or fewer',
      );
    }

    return normalized;
  }

  private normalizeSourceTag(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }

    const normalized = String(value).trim().toLowerCase().replace(/\s+/g, '_');

    return normalized || null;
  }

  private buildCanonicalKey(
    category: string,
    subcategory: string,
    item: string,
  ) {
    return `${category}:${subcategory}:${item}`;
  }

  private assertJsonFile(file: ImportTaxonomyFile) {
    const filename = file.originalname?.trim().toLowerCase() ?? '';
    const mime = file.mimetype?.trim().toLowerCase() ?? '';
    const looksLikeJson =
      filename.endsWith('.json') ||
      mime.includes('json') ||
      mime === 'text/plain' ||
      mime === 'application/octet-stream' ||
      mime === '';

    if (!looksLikeJson) {
      throw new BadRequestException('Only JSON files are supported');
    }
  }

  private toTagResponse(tag: TagRecord): TagListItemResponse {
    return {
      id: tag.id,
      key: tag.key,
      category: tag.category,
      subcategory: tag.subcategory,
      item: tag.item,
      description: tag.description,
      createdAt: tag.createdAt,
      updatedAt: tag.updatedAt,
      metricLinksCount: tag._count.metricLinks,
      manualLinksCount: tag._count.manualLinks,
    };
  }
}
