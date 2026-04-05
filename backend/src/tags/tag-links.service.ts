import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { TagMatcherService, type MatchableTag } from './tag-matcher.service';

export interface TagLinkSummary {
  id: string;
  key: string;
  category: string;
  subcategory: string;
  item: string;
  description: string | null;
}

type RebuildScope = 'all' | 'metrics' | 'manuals';

const TAG_LINK_SELECT = {
  id: true,
  key: true,
  category: true,
  subcategory: true,
  item: true,
  description: true,
} as const;

const MANUAL_CONTENT_TAG_MAX_CHUNKS = 120;
const MANUAL_CONTENT_TAG_MAX_CHARS = 24_000;
const MANUAL_CONTENT_TAG_MIN_SCORE = 18;
const MANUAL_CONTENT_TAG_MIN_HITS = 2;

interface QueryTagMatch {
  tagId: string;
  key: string;
  score: number;
}

@Injectable()
export class TagLinksService {
  private readonly logger = new Logger(TagLinksService.name);
  private cachedTagProfiles:
    | Array<{
        tag: MatchableTag;
        profile: ReturnType<TagMatcherService['buildProfiles']>[number];
      }>
    | null = null;
  private cachedAt = 0;
  private readonly cacheTtlMs = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly matcher: TagMatcherService,
    @Optional() private readonly ragflow?: RagflowService,
  ) {}

  invalidateTagCache(): void {
    this.cachedTagProfiles = null;
    this.cachedAt = 0;
  }

  async listTagOptions(): Promise<TagLinkSummary[]> {
    const tags = await this.prisma.tag.findMany({
      orderBy: [{ category: 'asc' }, { subcategory: 'asc' }, { item: 'asc' }],
      select: TAG_LINK_SELECT,
    });

    return tags.map((tag) => ({ ...tag }));
  }

  async listMetricTags(metricKey: string): Promise<TagLinkSummary[]> {
    await this.assertMetricExists(metricKey);

    const links = await this.prisma.metricDefinitionTag.findMany({
      where: { metricKey },
      take: 1,
      orderBy: {
        tag: { key: 'asc' },
      },
      select: {
        tag: {
          select: TAG_LINK_SELECT,
        },
      },
    });

    return links.map((link) => ({ ...link.tag }));
  }

  async replaceMetricTags(
    metricKey: string,
    tagIds: string[] | undefined,
  ): Promise<TagLinkSummary[]> {
    await this.assertMetricExists(metricKey);
    const normalizedTagIds = this.normalizeTagIds(tagIds);
    await this.assertTagIdsExist(normalizedTagIds);

    await this.prisma.$transaction(async (tx) => {
      await tx.metricDefinitionTag.deleteMany({
        where: { metricKey },
      });

      if (normalizedTagIds.length > 0) {
        await tx.metricDefinitionTag.createMany({
          data: normalizedTagIds.map((tagId) => ({ metricKey, tagId })),
          skipDuplicates: true,
        });
      }
    });

    const tags = await this.listMetricTags(metricKey);
    this.logger.debug(
      `Metric tag override metric=${metricKey} tags=${tags.length > 0 ? tags.map((tag) => tag.key).join(',') : 'none'}`,
    );

    return tags;
  }

  async listManualTags(
    shipId: string,
    manualId: string,
  ): Promise<TagLinkSummary[]> {
    await this.assertShipManualExists(shipId, manualId);

    const links = await this.prisma.shipManualTag.findMany({
      where: { shipManualId: manualId },
      take: 1,
      orderBy: {
        tag: { key: 'asc' },
      },
      select: {
        tag: {
          select: TAG_LINK_SELECT,
        },
      },
    });

    return links.map((link) => ({ ...link.tag }));
  }

  async replaceManualTags(
    shipId: string,
    manualId: string,
    tagIds: string[] | undefined,
  ): Promise<TagLinkSummary[]> {
    await this.assertShipManualExists(shipId, manualId);
    const normalizedTagIds = this.normalizeTagIds(tagIds);
    await this.assertTagIdsExist(normalizedTagIds);

    await this.prisma.$transaction(async (tx) => {
      await tx.shipManualTag.deleteMany({
        where: { shipManualId: manualId },
      });

      if (normalizedTagIds.length > 0) {
        await tx.shipManualTag.createMany({
          data: normalizedTagIds.map((tagId) => ({ shipManualId: manualId, tagId })),
          skipDuplicates: true,
        });
      }
    });

    const tags = await this.listManualTags(shipId, manualId);
    this.logger.debug(
      `Manual tag override ship=${shipId} manual=${manualId} tags=${tags.length > 0 ? tags.map((tag) => tag.key).join(',') : 'none'}`,
    );

    return tags;
  }

  async autoLinkMetrics(
    metricKeys: string[],
    options?: { replaceExisting?: boolean },
  ) {
    const uniqueMetricKeys = [...new Set(metricKeys.map((key) => key?.trim()).filter(Boolean))];
    if (uniqueMetricKeys.length === 0) {
      return { processed: 0, linked: 0, untouched: 0, cleared: 0 };
    }

    const profiles = await this.loadTagProfiles();
    if (profiles.length === 0) {
      return { processed: 0, linked: 0, untouched: uniqueMetricKeys.length, cleared: 0 };
    }
    const tagKeyById = new Map(
      profiles.map((profile) => [profile.tag.id, profile.tag.key] as const),
    );

    const definitions = await this.prisma.metricDefinition.findMany({
      where: { key: { in: uniqueMetricKeys } },
      select: {
        key: true,
        label: true,
        description: true,
        unit: true,
        bucket: true,
        measurement: true,
        field: true,
        tags: {
          select: {
            tagId: true,
          },
        },
      },
    });

    const eligible = definitions.filter(
      (definition) => options?.replaceExisting || definition.tags.length === 0,
    );
    if (eligible.length === 0) {
      return {
        processed: definitions.length,
        linked: 0,
        untouched: definitions.length,
        cleared: 0,
      };
    }

    const assignments = eligible.map((definition) => {
      const tagIds = this.pickSingleTagIds(
        this.matchMetricDefinitionTagIds(definition, profiles),
      );

      return {
        metricKey: definition.key,
        existingCount: definition.tags.length,
        tagIds,
      };
    });

    if (options?.replaceExisting) {
      await this.prisma.metricDefinitionTag.deleteMany({
        where: {
          metricKey: {
            in: assignments.map((assignment) => assignment.metricKey),
          },
        },
      });
    }

    const createData = assignments.flatMap((assignment) =>
      assignment.tagIds.map((tagId) => ({
        metricKey: assignment.metricKey,
        tagId,
      })),
    );

    if (createData.length > 0) {
      await this.prisma.metricDefinitionTag.createMany({
        data: createData,
        skipDuplicates: true,
      });
    }

    const result = {
      processed: definitions.length,
      linked: assignments.filter((assignment) => assignment.tagIds.length > 0)
        .length,
      untouched: definitions.length - eligible.length,
      cleared: options?.replaceExisting
        ? assignments.filter(
            (assignment) =>
              assignment.existingCount > 0 && assignment.tagIds.length === 0,
          ).length
        : 0,
    };

    const linkedSamples = assignments
      .filter((assignment) => assignment.tagIds.length > 0)
      .slice(0, 5)
      .map(
        (assignment) =>
          `${assignment.metricKey}=>${tagKeyById.get(assignment.tagIds[0]) ?? assignment.tagIds[0]}`,
      )
      .join(', ');
    this.logger.debug(
      `Metric auto-link processed=${result.processed} eligible=${eligible.length} linked=${result.linked} untouched=${result.untouched} cleared=${result.cleared} replaceExisting=${options?.replaceExisting === true} ${linkedSamples ? `sample=${linkedSamples}` : 'sample=none'}`,
    );

    return result;
  }

  async autoLinkManuals(
    manualIds: string[],
    options?: { replaceExisting?: boolean },
  ) {
    const uniqueManualIds = [...new Set(manualIds.map((id) => id?.trim()).filter(Boolean))];
    if (uniqueManualIds.length === 0) {
      return { processed: 0, linked: 0, untouched: 0, cleared: 0 };
    }

    const profiles = await this.loadTagProfiles();
    if (profiles.length === 0) {
      return { processed: 0, linked: 0, untouched: uniqueManualIds.length, cleared: 0 };
    }
    const tagKeyById = new Map(
      profiles.map((profile) => [profile.tag.id, profile.tag.key] as const),
    );

    const manuals = await this.prisma.shipManual.findMany({
      where: { id: { in: uniqueManualIds } },
      select: {
        id: true,
        filename: true,
        category: true,
        ragflowDocumentId: true,
        ship: {
          select: {
            ragflowDatasetId: true,
          },
        },
        tags: {
          select: {
            tagId: true,
          },
        },
      },
    });

    const eligible = manuals.filter(
      (manual) => options?.replaceExisting || manual.tags.length === 0,
    );
    if (eligible.length === 0) {
      return {
        processed: manuals.length,
        linked: 0,
        untouched: manuals.length,
        cleared: 0,
      };
    }

    const assignments = await Promise.all(
      eligible.map(async (manual) => {
        const match = await this.matchManualTagIds(manual, profiles);
        return {
          manualId: manual.id,
          manualLabel: manual.filename,
          existingCount: manual.tags.length,
          source: match.source,
          tagIds: this.pickSingleTagIds(match.tagIds),
        };
      }),
    );

    if (options?.replaceExisting) {
      await this.prisma.shipManualTag.deleteMany({
        where: {
          shipManualId: {
            in: assignments.map((assignment) => assignment.manualId),
          },
        },
      });
    }

    const createData = assignments.flatMap((assignment) =>
      assignment.tagIds.map((tagId) => ({
        shipManualId: assignment.manualId,
        tagId,
      })),
    );

    if (createData.length > 0) {
      await this.prisma.shipManualTag.createMany({
        data: createData,
        skipDuplicates: true,
      });
    }

    const result = {
      processed: manuals.length,
      linked: assignments.filter((assignment) => assignment.tagIds.length > 0)
        .length,
      untouched: manuals.length - eligible.length,
      cleared: options?.replaceExisting
        ? assignments.filter(
            (assignment) =>
              assignment.existingCount > 0 && assignment.tagIds.length === 0,
          ).length
        : 0,
    };

    const linkedSamples = assignments
      .filter((assignment) => assignment.tagIds.length > 0)
      .slice(0, 5)
      .map(
        (assignment) =>
          `${assignment.manualLabel}=>${tagKeyById.get(assignment.tagIds[0]) ?? assignment.tagIds[0]}(${assignment.source})`,
      )
      .join(', ');
    this.logger.debug(
      `Manual auto-link processed=${result.processed} eligible=${eligible.length} linked=${result.linked} untouched=${result.untouched} cleared=${result.cleared} replaceExisting=${options?.replaceExisting === true} ${linkedSamples ? `sample=${linkedSamples}` : 'sample=none'}`,
    );

    return result;
  }

  async rebuildLinks(options?: {
    scope?: RebuildScope;
    shipId?: string;
    replaceExisting?: boolean;
  }): Promise<{
    scope: RebuildScope;
    replaceExisting: boolean;
    metrics: { processed: number; linked: number; untouched: number; cleared: number };
    manuals: { processed: number; linked: number; untouched: number; cleared: number };
  }> {
    const scope = options?.scope ?? 'all';
    const replaceExisting = options?.replaceExisting === true;
    const metrics =
      scope === 'manuals'
        ? { processed: 0, linked: 0, untouched: 0, cleared: 0 }
        : await this.autoLinkMetrics(
            (
              await this.prisma.metricDefinition.findMany({
                select: { key: true },
              })
            ).map((metric) => metric.key),
            { replaceExisting },
          );

    const manualIds =
      scope === 'metrics'
        ? []
        : (
            await this.prisma.shipManual.findMany({
              where: options?.shipId ? { shipId: options.shipId } : undefined,
              select: { id: true },
            })
          ).map((manual) => manual.id);
    const manuals =
      scope === 'metrics'
        ? { processed: 0, linked: 0, untouched: 0, cleared: 0 }
        : await this.autoLinkManuals(manualIds, { replaceExisting });

    return {
      scope,
      replaceExisting,
      metrics,
      manuals,
    };
  }

  async findTaggedMetricKeysForShipQuery(
    shipId: string,
    query: string,
  ): Promise<string[]> {
    const tagMatches = await this.matchQueryTags(query);
    if (tagMatches.length === 0) {
      this.logger.debug(
        `Telemetry tag scope ship=${shipId} query="${this.truncateForLog(query)}" matchedTags=none scopedMetrics=0`,
      );
      return [];
    }
    const tagIds = tagMatches.map((match) => match.tagId);

    const rows = await this.prisma.shipMetricsConfig.findMany({
      where: {
        shipId,
        isActive: true,
        metric: {
          tags: {
            some: {
              tagId: { in: tagIds },
            },
          },
        },
      },
      select: { metricKey: true },
    });

    const metricKeys = rows.map((row) => row.metricKey);
    this.logger.debug(
      `Telemetry tag scope ship=${shipId} query="${this.truncateForLog(query)}" matchedTags=${tagMatches.map((match) => match.key).join(',')} scopedMetrics=${metricKeys.length}${metricKeys.length > 0 ? ` sample=${metricKeys.slice(0, 5).join(',')}` : ''}`,
    );

    return metricKeys;
  }

  async findTaggedManualIdsForShipQuery(
    shipId: string,
    query: string,
    categories?: string[],
  ): Promise<string[]> {
    const tagMatches = await this.matchQueryTags(query);
    if (tagMatches.length === 0) {
      this.logger.debug(
        `Manual tag scope ship=${shipId} query="${this.truncateForLog(query)}" matchedTags=none scopedManuals=0`,
      );
      return [];
    }
    const tagIds = tagMatches.map((match) => match.tagId);

    const rows = await this.prisma.shipManual.findMany({
      where: {
        shipId,
        ...(categories?.length ? { category: { in: categories } } : {}),
        tags: {
          some: {
            tagId: { in: tagIds },
          },
        },
      },
      select: { id: true },
    });

    const manualIds = rows.map((row) => row.id);
    this.logger.debug(
      `Manual tag scope ship=${shipId} query="${this.truncateForLog(query)}" matchedTags=${tagMatches.map((match) => match.key).join(',')} scopedManuals=${manualIds.length}${categories?.length ? ` categories=${categories.join(',')}` : ''}`,
    );

    return manualIds;
  }

  async findTaggedManualIdsForAdminQuery(
    query: string,
    categories?: string[],
  ): Promise<string[]> {
    const tagMatches = await this.matchQueryTags(query);
    if (tagMatches.length === 0) {
      this.logger.debug(
        `Manual tag scope admin query="${this.truncateForLog(query)}" matchedTags=none scopedManuals=0`,
      );
      return [];
    }
    const tagIds = tagMatches.map((match) => match.tagId);

    const rows = await this.prisma.shipManual.findMany({
      where: {
        ...(categories?.length ? { category: { in: categories } } : {}),
        tags: {
          some: {
            tagId: { in: tagIds },
          },
        },
      },
      select: { id: true },
    });

    const manualIds = rows.map((row) => row.id);
    this.logger.debug(
      `Manual tag scope admin query="${this.truncateForLog(query)}" matchedTags=${tagMatches.map((match) => match.key).join(',')} scopedManuals=${manualIds.length}${categories?.length ? ` categories=${categories.join(',')}` : ''}`,
    );

    return manualIds;
  }

  private async matchQueryTagIds(query: string): Promise<string[]> {
    return (await this.matchQueryTags(query)).map((match) => match.tagId);
  }

  private async matchQueryTags(query: string): Promise<QueryTagMatch[]> {
    const profiles = await this.loadTagProfiles();
    if (profiles.length === 0) {
      return [];
    }

    const profileByTagId = new Map(
      profiles.map((entry) => [entry.tag.id, entry.tag] as const),
    );

    return this.matcher
      .matchTags(
        profiles.map((entry) => entry.profile),
        query,
        'query',
      )
      .map((match) => ({
        ...match,
        key: profileByTagId.get(match.tagId)?.key ?? match.tagId,
      }));
  }

  private async loadTagProfiles() {
    const now = Date.now();
    if (
      this.cachedTagProfiles &&
      now - this.cachedAt < this.cacheTtlMs
    ) {
      return this.cachedTagProfiles;
    }

    const tags = await this.prisma.tag.findMany({
      orderBy: [{ category: 'asc' }, { subcategory: 'asc' }, { item: 'asc' }],
      select: TAG_LINK_SELECT,
    });
    const profiles = this.matcher.buildProfiles(tags);

    this.cachedTagProfiles = profiles.map((profile) => ({
      tag: profile.tag,
      profile,
    }));
    this.cachedAt = now;

    return this.cachedTagProfiles;
  }

  private buildMetricMatchText(metric: {
    key: string;
    label: string;
    description: string | null;
    unit: string | null;
    bucket: string | null;
    measurement: string | null;
    field: string | null;
  }): string {
    return [
      metric.key,
      metric.label,
      metric.bucket,
      metric.measurement,
      metric.field,
      metric.description,
      metric.unit,
    ]
      .filter(Boolean)
      .join(' ');
  }

  private buildMetricPrimaryMatchText(metric: {
    description: string | null;
    unit: string | null;
    field: string | null;
  }): string {
    return [metric.field, metric.description, metric.unit]
      .filter(Boolean)
      .join(' ');
  }

  private buildManualMatchText(manual: {
    filename: string;
    category: string;
  }): string {
    return [manual.filename, manual.category].filter(Boolean).join(' ');
  }

  private async matchManualTagIds(
    manual: {
      id: string;
      filename: string;
      category: string;
      ragflowDocumentId: string;
      ship: { ragflowDatasetId: string | null };
    },
    profiles: Array<{
      tag: MatchableTag;
      profile: ReturnType<TagMatcherService['buildProfiles']>[number];
    }>,
  ): Promise<{ tagIds: string[]; source: 'content' | 'title' | 'none' }> {
    const matcherProfiles = profiles.map((entry) => entry.profile);
    const titleMatches = this.matcher
      .matchTags(matcherProfiles, this.buildManualMatchText(manual), 'manual')
      .map((match) => match.tagId);
    const contentMatches = await this.matchManualTagIdsFromContent(
      manual,
      profiles,
      titleMatches,
    );

    if (contentMatches.length > 0) {
      return { tagIds: contentMatches, source: 'content' };
    }
    if (titleMatches.length > 0) {
      return { tagIds: titleMatches, source: 'title' };
    }

    return { tagIds: [], source: 'none' };
  }

  private async matchManualTagIdsFromContent(
    manual: {
      id: string;
      filename: string;
      category: string;
      ragflowDocumentId: string;
      ship: { ragflowDatasetId: string | null };
    },
    profiles: Array<{
      tag: MatchableTag;
      profile: ReturnType<TagMatcherService['buildProfiles']>[number];
    }>,
    titleMatches: string[],
  ): Promise<string[]> {
    const datasetId = manual.ship.ragflowDatasetId?.trim();
    const documentId = manual.ragflowDocumentId?.trim();
    if (!this.ragflow?.isConfigured() || !datasetId || !documentId) {
      return [];
    }

    try {
      const chunks = await this.ragflow.listDocumentChunks(datasetId, documentId, 200);
      return this.rankManualContentTagMatches(manual, chunks, profiles, titleMatches);
    } catch {
      return [];
    }
  }

  private rankManualContentTagMatches(
    manual: {
      filename: string;
      category: string;
    },
    chunks: Array<{ content: string }>,
    profiles: Array<{
      tag: MatchableTag;
      profile: ReturnType<TagMatcherService['buildProfiles']>[number];
    }>,
    titleMatches: string[],
  ): string[] {
    if (chunks.length === 0) {
      return [];
    }

    const matcherProfiles = profiles.map((entry) => entry.profile);
    const titleAlignedTagIds = new Set(titleMatches);
    const evidence = new Map<
      string,
      {
        tagId: string;
        totalScore: number;
        bestScore: number;
        hitCount: number;
        primaryHitCount: number;
        titleAligned: boolean;
      }
    >();
    let consumedChars = 0;
    let inspectedChunks = 0;

    for (const chunk of chunks) {
      if (
        inspectedChunks >= MANUAL_CONTENT_TAG_MAX_CHUNKS ||
        consumedChars >= MANUAL_CONTENT_TAG_MAX_CHARS
      ) {
        break;
      }

      const normalizedContent = this.normalizeManualChunkText(chunk.content);
      if (!normalizedContent) {
        continue;
      }

      const remainingChars = MANUAL_CONTENT_TAG_MAX_CHARS - consumedChars;
      const chunkText = normalizedContent.slice(0, remainingChars);
      if (!chunkText) {
        break;
      }

      consumedChars += chunkText.length;
      inspectedChunks += 1;

      const matches = this.matcher.matchTags(matcherProfiles, chunkText, 'manual');
      matches.forEach((match, index) => {
        const entry = evidence.get(match.tagId) ?? {
          tagId: match.tagId,
          totalScore: 0,
          bestScore: 0,
          hitCount: 0,
          primaryHitCount: 0,
          titleAligned: titleAlignedTagIds.has(match.tagId),
        };

        entry.totalScore += match.score;
        entry.bestScore = Math.max(entry.bestScore, match.score);
        entry.hitCount += 1;
        if (index === 0) {
          entry.primaryHitCount += 1;
        }

        evidence.set(match.tagId, entry);
      });
    }

    if (evidence.size === 0) {
      return [];
    }

    const ranked = [...evidence.values()]
      .map((entry) => ({
        ...entry,
        compositeScore:
          entry.totalScore +
          entry.hitCount * 3 +
          entry.primaryHitCount * 2 +
          (entry.titleAligned ? 4 : 0),
      }))
      .sort((left, right) => {
        if (right.compositeScore !== left.compositeScore) {
          return right.compositeScore - left.compositeScore;
        }
        if (right.bestScore !== left.bestScore) {
          return right.bestScore - left.bestScore;
        }
        if (right.hitCount !== left.hitCount) {
          return right.hitCount - left.hitCount;
        }
        return left.tagId.localeCompare(right.tagId);
      });

    const top = ranked[0];
    const second = ranked[1];
    if (
      !top ||
      top.totalScore < MANUAL_CONTENT_TAG_MIN_SCORE ||
      top.hitCount < MANUAL_CONTENT_TAG_MIN_HITS ||
      top.bestScore < 9
    ) {
      return [];
    }

    const comfortablyAhead =
      !second ||
      top.compositeScore >= second.compositeScore + 6 ||
      top.hitCount >= second.hitCount + 2 ||
      (top.titleAligned && top.compositeScore >= second.compositeScore + 3);
    if (!comfortablyAhead) {
      return [];
    }

    return [top.tagId];
  }

  private normalizeManualChunkText(content: string): string {
    const normalized = content.replace(/\s+/g, ' ').trim();
    if (normalized.length < 48) {
      return '';
    }

    return normalized;
  }

  private matchMetricDefinitionTagIds(
    metric: {
      key: string;
      label: string;
      description: string | null;
      unit: string | null;
      bucket: string | null;
      measurement: string | null;
      field: string | null;
    },
    profiles: Array<{
      tag: MatchableTag;
      profile: ReturnType<TagMatcherService['buildProfiles']>[number];
    }>,
  ): string[] {
    const matcherProfiles = profiles.map((entry) => entry.profile);
    const primaryMatches = this.matcher.matchTags(
      matcherProfiles,
      this.buildMetricPrimaryMatchText(metric),
      'metric',
    );

    if (primaryMatches.length > 0) {
      return primaryMatches.map((match) => match.tagId);
    }

    if (metric.description?.trim()) {
      return [];
    }

    return this.matcher
      .matchTags(matcherProfiles, this.buildMetricMatchText(metric), 'metric')
      .map((match) => match.tagId);
  }

  private normalizeTagIds(tagIds: string[] | undefined): string[] {
    const normalized = [...new Set((tagIds ?? []).map((id) => id?.trim()).filter(Boolean))];

    if (normalized.length > 1) {
      throw new BadRequestException(
        'Only one tag can be linked to a metric or document',
      );
    }

    return normalized;
  }

  private pickSingleTagIds(tagIds: string[]): string[] {
    const normalized = [...new Set(tagIds.map((id) => id?.trim()).filter(Boolean))];
    return normalized.length > 0 ? [normalized[0]] : [];
  }

  private truncateForLog(value: string, maxLength: number = 140): string {
    const normalized = value.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }

    return `${normalized.slice(0, maxLength - 1)}…`;
  }

  private async assertTagIdsExist(tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) {
      return;
    }

    const tags = await this.prisma.tag.findMany({
      where: { id: { in: tagIds } },
      select: { id: true },
    });
    if (tags.length !== tagIds.length) {
      throw new BadRequestException('One or more tag IDs are invalid');
    }
  }

  private async assertMetricExists(metricKey: string): Promise<void> {
    const metric = await this.prisma.metricDefinition.findUnique({
      where: { key: metricKey },
      select: { key: true },
    });
    if (!metric) {
      throw new NotFoundException('Metric definition not found');
    }
  }

  private async assertShipManualExists(
    shipId: string,
    manualId: string,
  ): Promise<void> {
    const manual = await this.prisma.shipManual.findFirst({
      where: { id: manualId, shipId },
      select: { id: true },
    });
    if (!manual) {
      throw new NotFoundException('Manual not found');
    }
  }
}
