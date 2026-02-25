import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService, RagflowUploadFile } from '../ragflow/ragflow.service';
import { UpdateManualDto } from './dto/update-manual.dto';

@Injectable()
export class ManualsService {
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

    // If manual is associated with RAGFlow dataset, must delete from RAGFlow first
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
        throw new ServiceUnavailableException(
          `Failed to delete document from RAGFlow: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.prisma.shipManual.delete({ where: { id: manualId } });
  }
}
