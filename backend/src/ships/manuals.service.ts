import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService, RagflowUploadFile } from '../ragflow/ragflow.service';
import { ManualsParseScheduler } from './manuals-parse.scheduler';
import { BulkRemoveManualsDto } from './dto/bulk-remove-manuals.dto';
import { UpdateManualDto } from './dto/update-manual.dto';

export interface ManualRecord {
  id: string;
  ragflowDocumentId: string;
  filename: string;
  uploadedAt: Date;
}

export interface ManualsPaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PaginatedManualsResult<T> {
  items: T[];
  pagination: ManualsPaginationMeta;
}

type ManualWithShip = {
  id: string;
  shipId: string;
  filename: string;
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
  ) {}

  private normalizeManualIds(ids?: string[]): string[] {
    if (!ids?.length) return [];
    return [...new Set(ids.map((id) => id?.trim()).filter(Boolean))];
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

  async create(shipId: string, file: RagflowUploadFile) {
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
    );
    const created: {
      id: string;
      filename: string;
      ragflowDocumentId: string;
      uploadedAt: Date;
    }[] = [];
    for (const doc of uploaded) {
      const manual = await this.prisma.shipManual.create({
        data: {
          shipId,
          ragflowDocumentId: doc.id,
          filename: doc.name,
        },
      });
      created.push({
        id: manual.id,
        filename: manual.filename,
        ragflowDocumentId: manual.ragflowDocumentId,
        uploadedAt: manual.uploadedAt,
      });
    }

    for (const doc of uploaded) {
      const filenameForConfig = file.originalname ?? doc.name;
      try {
        await this.ragflow.updateDocumentConfig(
          ship.ragflowDatasetId,
          doc.id,
          filenameForConfig,
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
  ): ManualsPaginationMeta {
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

  private async getManualPage(
    shipId: string,
    page?: number,
    pageSize?: number,
  ): Promise<PaginatedManualsResult<ManualRecord>> {
    const pagination = this.normalizePagination(page, pageSize);
    const total = await this.prisma.shipManual.count({ where: { shipId } });
    const meta = this.buildPaginationMeta(
      total,
      pagination.page,
      pagination.pageSize,
    );

    const manuals = await this.prisma.shipManual.findMany({
      where: { shipId },
      orderBy: { uploadedAt: 'desc' },
      skip: (meta.page - 1) * meta.pageSize,
      take: meta.pageSize,
      select: {
        id: true,
        ragflowDocumentId: true,
        filename: true,
        uploadedAt: true,
      },
    });

    return {
      items: manuals,
      pagination: meta,
    };
  }

  async findAll(
    shipId: string,
    page?: number,
    pageSize?: number,
  ): Promise<PaginatedManualsResult<ManualRecord>> {
    const ship = await this.prisma.ship.findUnique({ where: { id: shipId } });
    if (!ship) throw new NotFoundException('Ship not found');
    return this.getManualPage(shipId, page, pageSize);
  }

  async findAllWithStatus(
    shipId: string,
    page?: number,
    pageSize?: number,
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

    const pageResult = await this.getManualPage(shipId, page, pageSize);
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
        uploadedAt: true,
      },
    });
    if (!manual) throw new NotFoundException('Manual not found');
    return manual;
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
    if (dto.filename === undefined) return this.findOne(shipId, manualId);
    return this.prisma.shipManual
      .update({
        where: { id: manualId },
        data: { filename: dto.filename },
      })
      .then((m) => ({
        id: m.id,
        ragflowDocumentId: m.ragflowDocumentId,
        filename: m.filename,
        uploadedAt: m.uploadedAt,
      }));
  }

  async bulkRemove(shipId: string, dto: BulkRemoveManualsDto) {
    const ship = await this.prisma.ship.findUnique({ where: { id: shipId } });
    if (!ship) throw new NotFoundException('Ship not found');

    const mode = dto.mode === 'all' ? 'all' : 'manualIds';
    const manualIds = this.normalizeManualIds(dto.manualIds);
    const excludeManualIds = this.normalizeManualIds(dto.excludeManualIds);

    if (mode === 'manualIds' && manualIds.length === 0) {
      throw new BadRequestException('No manuals selected');
    }

    const manuals = await this.prisma.shipManual.findMany({
      where:
        mode === 'all'
          ? {
              shipId,
              ...(excludeManualIds.length > 0
                ? { id: { notIn: excludeManualIds } }
                : {}),
            }
          : {
              shipId,
              id: { in: manualIds },
            },
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
