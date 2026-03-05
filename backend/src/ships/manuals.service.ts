import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService, RagflowUploadFile } from '../ragflow/ragflow.service';
import { UpdateManualDto } from './dto/update-manual.dto';

@Injectable()
export class ManualsService {
  private readonly logger = new Logger(ManualsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
  ) {}

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
    try {
      await this.ragflow.parseDocuments(
        ship.ragflowDatasetId,
        uploaded.map((d) => d.id),
      );
    } catch {
      // manuals are stored; parsing may run async in RAGFlow
    }
    return created.length === 1 ? created[0] : created;
  }

  async findAll(shipId: string) {
    const ship = await this.prisma.ship.findUnique({ where: { id: shipId } });
    if (!ship) throw new NotFoundException('Ship not found');
    return this.prisma.shipManual.findMany({
      where: { shipId },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        ragflowDocumentId: true,
        filename: true,
        uploadedAt: true,
      },
    });
  }

  async findAllWithStatus(shipId: string) {
    const ship = await this.prisma.ship.findUnique({ where: { id: shipId } });
    if (!ship) throw new NotFoundException('Ship not found');

    const manuals = await this.prisma.shipManual.findMany({
      where: { shipId },
      orderBy: { uploadedAt: 'desc' },
      select: {
        id: true,
        ragflowDocumentId: true,
        filename: true,
        uploadedAt: true,
      },
    });

    if (
      !manuals.length ||
      !ship.ragflowDatasetId ||
      !this.ragflow.isConfigured()
    ) {
      return manuals.map((m) => ({
        ...m,
        run: null as string | null,
        progress: null as number | null,
        progressMsg: null as string | null,
        chunkCount: null as number | null,
      }));
    }

    try {
      const docs = await this.ragflow.listDocuments(ship.ragflowDatasetId);
      const docMap = new Map(docs.map((d) => [d.id, d]));

      return manuals.map((m) => {
        const doc = docMap.get(m.ragflowDocumentId);
        return {
          ...m,
          run: doc?.run ?? null,
          progress: doc?.progress ?? null,
          progressMsg: doc?.progress_msg ?? null,
          chunkCount: doc?.chunk_count ?? null,
        };
      });
    } catch (err) {
      this.logger.warn(
        `Failed to fetch RAGFlow document statuses: ${err instanceof Error ? err.message : String(err)}`,
      );
      return manuals.map((m) => ({
        ...m,
        run: null as string | null,
        progress: null as number | null,
        progressMsg: null as string | null,
        chunkCount: null as number | null,
      }));
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

  async remove(shipId: string, manualId: string) {
    const manual = await this.prisma.shipManual.findFirst({
      where: { id: manualId, shipId },
      include: { ship: true },
    });
    if (!manual) throw new NotFoundException('Manual not found');

    // If manual is associated with RAGFlow dataset, try to delete from RAGFlow
    if (manual.ship.ragflowDatasetId) {
      if (!this.ragflow.isConfigured()) {
        throw new ServiceUnavailableException(
          'RAGFlow service is not available',
        );
      }
      try {
        await this.ragflow.deleteDocument(
          manual.ship.ragflowDatasetId,
          manual.ragflowDocumentId,
        );
      } catch (error) {
        // Document may already be removed from RAGFlow — log and continue
        this.logger.warn(
          `RAGFlow document deletion failed for manual ${manualId}, proceeding with DB removal: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.prisma.shipManual.delete({ where: { id: manualId } });
  }
}
