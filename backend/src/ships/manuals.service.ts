import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService, RagflowUploadFile } from '../ragflow/ragflow.service';
import { TagLinksService } from '../tags/tag-links.service';
import { ManualsParseScheduler } from './manuals-parse.scheduler';
import { BulkRemoveManualsDto } from './dto/bulk-remove-manuals.dto';
import { UpdateManualDto } from './dto/update-manual.dto';
import {
  DEFAULT_SHIP_MANUAL_CATEGORY,
  SHIP_MANUAL_CATEGORY_DETAILS,
  parseShipManualCategory,
  resolveShipManualCategory,
  type ShipManualCategory,
} from './manual-category';
import {
  buildManualPaginationMeta,
  normalizeManualPagination,
} from './manuals/manual-pagination.utils';
import {
  buildManualWhere,
  normalizeManualIds,
  normalizeManualSearchTerm,
} from './manuals/manual-query.utils';
import type {
  ManualRecord,
  PaginatedManualsResult,
} from './manuals/manual-pagination.types';
export type {
  ManualRecord,
  ManualsPaginationMeta,
  PaginatedManualsResult,
} from './manuals/manual-pagination.types';

type ManualWithShip = {
  id: string;
  shipId: string;
  filename: string;
  category: string;
  ragflowDocumentId: string;
  uploadedAt: Date;
  ship: {
    ragflowDatasetId: string | null;
  };
};

@Injectable()
export class ManualsService {
  private readonly logger = new Logger(ManualsService.name);
  private readonly defaultPageSize = 25;
  private readonly maxPageSize = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
    private readonly manualsParseScheduler: ManualsParseScheduler,
    @Optional() private readonly tagLinks?: TagLinksService,
  ) {}

  private getCategoryMetadata(category: ShipManualCategory) {
    const details =
      SHIP_MANUAL_CATEGORY_DETAILS[category] ??
      SHIP_MANUAL_CATEGORY_DETAILS[DEFAULT_SHIP_MANUAL_CATEGORY];
    return {
      category,
      categoryLabel: details.label,
      ragflowParentPath: details.ragflowParentPath,
    };
  }

  private async removeManualRecord(manual: NonNullable<ManualWithShip>) {
    if (!manual.ship.ragflowDatasetId) return;

    if (!this.ragflow.isConfigured()) {
      throw new ServiceUnavailableException('RAGFlow service is not available');
    }

    try {
      await this.ragflow.deleteDocument(
        manual.ship.ragflowDatasetId,
        manual.ragflowDocumentId,
      );
    } catch (error) {
      // Document may already be removed from RAGFlow; continue with DB cleanup.
      this.logger.warn(
        `RAGFlow document deletion failed for manual ${manual.id}, proceeding with DB removal: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async removeManualRecordsBulk(
    manuals: NonNullable<ManualWithShip>[],
  ): Promise<void> {
    if (!manuals.length) return;

    const datasetId = manuals[0]?.ship.ragflowDatasetId;
    if (!datasetId) return;

    if (!this.ragflow.isConfigured()) {
      throw new ServiceUnavailableException('RAGFlow service is not available');
    }

    const documentIds = [
      ...new Set(
        manuals
          .map((manual) => manual.ragflowDocumentId?.trim())
          .filter(Boolean),
      ),
    ];
    if (!documentIds.length) return;

    try {
      await this.ragflow.deleteDocuments(datasetId, documentIds);
      return;
    } catch (error) {
      this.logger.warn(
        `Bulk RAGFlow document deletion failed for ship ${manuals[0]?.shipId}, falling back to per-document cleanup: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const settled = await Promise.allSettled(
      documentIds.map((documentId) =>
        this.ragflow.deleteDocument(datasetId, documentId),
      ),
    );
    const failedCount = settled.filter(
      (result) => result.status === 'rejected',
    ).length;

    if (failedCount > 0) {
      this.logger.warn(
        `RAGFlow fallback document deletion still failed for ${failedCount} manual(s); proceeding with DB cleanup`,
      );
    }
  }

  async create(
    shipId: string,
    file: RagflowUploadFile,
    options?: { category?: ShipManualCategory },
  ) {
    const category = resolveShipManualCategory(options?.category);
    const categoryMeta = this.getCategoryMetadata(category);
    const ship = await this.prisma.ship.findUnique({ where: { id: shipId } });
    if (!ship) throw new NotFoundException('Ship not found');
    if (!ship.ragflowDatasetId) {
      if (!this.ragflow.isConfigured())
        throw new ServiceUnavailableException('RAGFlow is not configured');
      try {
        const datasetId = await this.ragflow.createDataset(`ship-${ship.id}`);
        if (datasetId) {
          await this.prisma.ship.update({
            where: { id: shipId },
            data: { ragflowDatasetId: datasetId },
          });
          ship.ragflowDatasetId = datasetId;
        }
      } catch {
        throw new ServiceUnavailableException(
          'Failed to create RAGFlow dataset for ship',
        );
      }
    } else {
      try {
        await this.ragflow.updateDatasetConfig(ship.ragflowDatasetId);
      } catch (err) {
        this.logger.warn(
          `Failed to update RAGFlow dataset config for ship ${shipId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!ship.ragflowDatasetId)
      throw new BadRequestException('Ship has no RAGFlow dataset');
    const uploaded = await this.ragflow.uploadDocument(
      ship.ragflowDatasetId,
      file,
      { parentPath: categoryMeta.ragflowParentPath },
    );
    const created: {
      id: string;
      filename: string;
      category: ShipManualCategory;
      ragflowDocumentId: string;
      uploadedAt: Date;
    }[] = [];
    for (const doc of uploaded) {
      const manual = await this.prisma.shipManual.create({
        data: {
          shipId,
          ragflowDocumentId: doc.id,
          filename: doc.name,
          category,
        },
      });
      created.push({
        id: manual.id,
        filename: manual.filename,
        category: manual.category as ShipManualCategory,
        ragflowDocumentId: manual.ragflowDocumentId,
        uploadedAt: manual.uploadedAt,
      });
    }
    await this.tagLinks?.autoLinkManuals(created.map((manual) => manual.id));

    for (const doc of uploaded) {
      const filenameForConfig = file.originalname ?? doc.name;
      try {
        await this.ragflow.updateDocumentConfig(
          ship.ragflowDatasetId,
          doc.id,
          filenameForConfig,
          {
            metaFields: {
              category,
              category_label: categoryMeta.categoryLabel,
            },
          },
        );
      } catch (err) {
        this.logger.warn(
          `Failed to update RAGFlow document config for document ${doc.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    this.manualsParseScheduler.notifyPendingDocuments();
    return created.length === 1 ? created[0] : created;
  }

  private async getManualPage(
    shipId: string,
    page?: number,
    pageSize?: number,
    category?: ShipManualCategory,
    search?: string,
  ): Promise<PaginatedManualsResult<ManualRecord>> {
    const pagination = normalizeManualPagination(page, pageSize, {
      defaultPageSize: this.defaultPageSize,
      maxPageSize: this.maxPageSize,
    });
    const where = buildManualWhere(shipId, {
      category,
      search,
    });
    const total = await this.prisma.shipManual.count({ where });
    const meta = buildManualPaginationMeta(
      total,
      pagination.page,
      pagination.pageSize,
    );

    const manuals = await this.prisma.shipManual.findMany({
      where,
      orderBy: { uploadedAt: 'desc' },
      skip: (meta.page - 1) * meta.pageSize,
      take: meta.pageSize,
      select: {
        id: true,
        ragflowDocumentId: true,
        filename: true,
        category: true,
        uploadedAt: true,
      },
    });

    return {
      items: manuals.map((manual) => ({
        ...manual,
        category: manual.category as ShipManualCategory,
      })),
      pagination: meta,
    };
  }

  async findAll(
    shipId: string,
    page?: number,
    pageSize?: number,
    category?: ShipManualCategory,
    search?: string,
  ): Promise<PaginatedManualsResult<ManualRecord>> {
    const ship = await this.prisma.ship.findUnique({ where: { id: shipId } });
    if (!ship) throw new NotFoundException('Ship not found');
    return this.getManualPage(shipId, page, pageSize, category, search);
  }

  async findAllWithStatus(
    shipId: string,
    page?: number,
    pageSize?: number,
    category?: ShipManualCategory,
    search?: string,
  ): Promise<
    PaginatedManualsResult<
      ManualRecord & {
        run: string | null;
        progress: number | null;
        progressMsg: string | null;
        chunkCount: number | null;
      }
    >
  > {
    const ship = await this.prisma.ship.findUnique({ where: { id: shipId } });
    if (!ship) throw new NotFoundException('Ship not found');

    const pageResult = await this.getManualPage(
      shipId,
      page,
      pageSize,
      category,
      search,
    );
    const manuals = pageResult.items;

    if (
      !manuals.length ||
      !ship.ragflowDatasetId ||
      !this.ragflow.isConfigured()
    ) {
      return {
        items: manuals.map((m) => ({
          ...m,
          run: null as string | null,
          progress: null as number | null,
          progressMsg: null as string | null,
          chunkCount: null as number | null,
        })),
        pagination: pageResult.pagination,
      };
    }

    try {
      const docs = await this.ragflow.listDocuments(
        ship.ragflowDatasetId,
        manuals.map((manual) => manual.ragflowDocumentId),
      );
      const docMap = new Map(docs.map((d) => [d.id, d]));

      return {
        items: manuals.map((m) => {
          const doc = docMap.get(m.ragflowDocumentId);
          return {
            ...m,
            run: doc?.run ?? null,
            progress: doc?.progress ?? null,
            progressMsg: doc?.progress_msg ?? null,
            chunkCount: doc?.chunk_count ?? null,
          };
        }),
        pagination: pageResult.pagination,
      };
    } catch (err) {
      this.logger.warn(
        `Failed to fetch RAGFlow document statuses: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        items: manuals.map((m) => ({
          ...m,
          run: null as string | null,
          progress: null as number | null,
          progressMsg: null as string | null,
          chunkCount: null as number | null,
        })),
        pagination: pageResult.pagination,
      };
    }
  }

  async findOne(shipId: string, manualId: string) {
    const manual = await this.prisma.shipManual.findFirst({
      where: { id: manualId, shipId },
      select: {
        id: true,
        ragflowDocumentId: true,
        filename: true,
        category: true,
        uploadedAt: true,
      },
    });
    if (!manual) throw new NotFoundException('Manual not found');
    return {
      ...manual,
      category: manual.category as ShipManualCategory,
    };
  }

  async listTags(shipId: string, manualId: string) {
    return this.tagLinks?.listManualTags(shipId, manualId) ?? [];
  }

  async download(shipId: string, manualId: string) {
    const manual = await this.prisma.shipManual.findFirst({
      where: { id: manualId, shipId },
      include: { ship: true },
    });
    if (!manual) throw new NotFoundException('Manual not found');
    if (!manual.ship.ragflowDatasetId) {
      throw new NotFoundException('Ship has no RAGFlow dataset');
    }
    if (!this.ragflow.isConfigured()) {
      throw new ServiceUnavailableException('RAGFlow is not configured');
    }
    return this.ragflow.downloadDocument(
      manual.ship.ragflowDatasetId,
      manual.ragflowDocumentId,
    );
  }

  async update(shipId: string, manualId: string, dto: UpdateManualDto) {
    const manual = await this.prisma.shipManual.findFirst({
      where: { id: manualId, shipId },
    });
    if (!manual) throw new NotFoundException('Manual not found');
    let category: ShipManualCategory | undefined;
    if (dto.category !== undefined) {
      category = parseShipManualCategory(dto.category);
      if (!category) {
        throw new BadRequestException('Invalid knowledge base category');
      }
    }
    if (dto.filename === undefined && category === undefined) {
      return this.findOne(shipId, manualId);
    }
    const updated = await this.prisma.shipManual.update({
      where: { id: manualId },
      data: {
        ...(dto.filename !== undefined ? { filename: dto.filename } : {}),
        ...(category !== undefined ? { category } : {}),
        semanticProfile: Prisma.DbNull,
        semanticProfileStatus: 'pending',
        semanticProfileVersion: null,
        semanticProfileUpdatedAt: null,
        semanticProfileError: null,
      },
    });
    await this.tagLinks?.autoLinkManuals([updated.id]);
    return {
      id: updated.id,
      ragflowDocumentId: updated.ragflowDocumentId,
      filename: updated.filename,
      category: updated.category as ShipManualCategory,
      uploadedAt: updated.uploadedAt,
    };
  }

  async replaceTags(
    shipId: string,
    manualId: string,
    tagIds: string[] | undefined,
  ) {
    return this.tagLinks?.replaceManualTags(shipId, manualId, tagIds) ?? [];
  }

  async bulkRemove(shipId: string, dto: BulkRemoveManualsDto) {
    const ship = await this.prisma.ship.findUnique({ where: { id: shipId } });
    if (!ship) throw new NotFoundException('Ship not found');

    const mode = dto.mode === 'all' ? 'all' : 'manualIds';
    const manualIds = normalizeManualIds(dto.manualIds);
    const excludeManualIds = normalizeManualIds(dto.excludeManualIds);
    const search = normalizeManualSearchTerm(dto.search);
    let category: ShipManualCategory | undefined;
    if (dto.category !== undefined) {
      category = parseShipManualCategory(dto.category);
      if (!category) {
        throw new BadRequestException('Invalid knowledge base category');
      }
    }

    if (mode === 'manualIds' && manualIds.length === 0) {
      throw new BadRequestException('No manuals selected');
    }

    const manuals = await this.prisma.shipManual.findMany({
      where:
        mode === 'all'
          ? buildManualWhere(shipId, {
              category,
              search,
              excludeManualIds,
            })
          : buildManualWhere(shipId, {
              includeManualIds: manualIds,
            }),
      include: { ship: true },
      orderBy: { uploadedAt: 'desc' },
    });

    if (!manuals.length) {
      return { deletedCount: 0 };
    }

    await this.removeManualRecordsBulk(manuals);

    const deleted = await this.prisma.shipManual.deleteMany({
      where: {
        shipId,
        id: { in: manuals.map((manual) => manual.id) },
      },
    });

    this.manualsParseScheduler.notifyPendingDocuments();
    return { deletedCount: deleted.count };
  }

  async remove(shipId: string, manualId: string) {
    const manual = await this.prisma.shipManual.findFirst({
      where: { id: manualId, shipId },
      include: { ship: true },
    });
    if (!manual) throw new NotFoundException('Manual not found');

    await this.removeManualRecord(manual);

    await this.prisma.shipManual.delete({ where: { id: manualId } });
    this.manualsParseScheduler.notifyPendingDocuments();
  }
}
