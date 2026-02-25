import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { CreateShipDto } from './dto/create-ship.dto';
import { UpdateShipDto } from './dto/update-ship.dto';

@Injectable()
export class ShipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
  ) {}

  async getMetricDefinitions() {
    return this.prisma.metricDefinition.findMany({
      orderBy: { key: 'asc' },
      select: {
        key: true,
        label: true,
        description: true,
        unit: true,
        dataType: true,
      },
    });
  }

  async create(dto: CreateShipDto) {
    if (dto.metricKeys?.length) {
      const existing = await this.prisma.metricDefinition.findMany({
        where: { key: { in: dto.metricKeys } },
        select: { key: true },
      });
      const existingKeys = new Set(existing.map((m) => m.key));
      const invalid = dto.metricKeys.filter((k) => !existingKeys.has(k));
      if (invalid.length) {
        throw new BadRequestException(
          `Unknown metric keys: ${invalid.join(', ')}`,
        );
      }
    }

    const userIds = dto.userIds ?? [];
    if (userIds.length) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, role: true, shipId: true },
      });
      const foundIds = new Set(users.map((u) => u.id));
      const missing = userIds.filter((id) => !foundIds.has(id));
      if (missing.length) {
        throw new BadRequestException(
          `User(s) not found: ${missing.join(', ')}`,
        );
      }
      const notUserRole = users.filter((u) => u.role !== 'user');
      if (notUserRole.length) {
        throw new BadRequestException(
          'Only users with role "user" can be assigned to a ship',
        );
      }
      const alreadyAssigned = users.filter((u) => u.shipId != null);
      if (alreadyAssigned.length) {
        throw new BadRequestException(
          'Some users are already assigned to another ship',
        );
      }
    }

    const ship = await this.prisma.ship.create({
      data: {
        name: dto.name,
        serialNumber: dto.serialNumber ?? undefined,
        metricsConfig:
          dto.metricKeys?.length > 0
            ? {
                create: dto.metricKeys.map((metricKey) => ({
                  metricKey,
                  isActive: true,
                })),
              }
            : undefined,
      },
      include: {
        metricsConfig: { select: { metricKey: true, isActive: true } },
        assignedUsers: { select: { id: true, userId: true } },
      },
    });

    if (userIds.length) {
      await this.prisma.user.updateMany({
        where: { id: { in: userIds } },
        data: { shipId: ship.id },
      });
    }
    if (this.ragflow.isConfigured()) {
      try {
        const datasetId = await this.ragflow.createDataset(`ship-${ship.id}`);
        if (datasetId) {
          await this.prisma.ship.update({
            where: { id: ship.id },
            data: { ragflowDatasetId: datasetId },
          });
        }
      } catch {
        // leave ragflow_dataset_id null
      }
    }
    return this.findOne(ship.id);
  }

  async findAll() {
    return this.prisma.ship.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        metricsConfig: { select: { metricKey: true, isActive: true } },
        assignedUsers: { select: { id: true, userId: true } },
        manuals: {
          select: {
            id: true,
            ragflowDocumentId: true,
            filename: true,
            uploadedAt: true,
          },
        },
      },
    });
  }

  async findOne(id: string) {
    const ship = await this.prisma.ship.findUnique({
      where: { id },
      include: {
        metricsConfig: {
          include: {
            metric: {
              select: { key: true, label: true, description: true, unit: true },
            },
          },
        },
        assignedUsers: { select: { id: true, userId: true } },
        manuals: {
          select: {
            id: true,
            ragflowDocumentId: true,
            filename: true,
            uploadedAt: true,
          },
        },
      },
    });
    if (!ship) throw new NotFoundException('Ship not found');
    return ship;
  }

  async update(id: string, dto: UpdateShipDto) {
    const ship = await this.prisma.ship.findUnique({ where: { id } });
    if (!ship) throw new NotFoundException('Ship not found');

    if (dto.metricKeys !== undefined) {
      const existing = await this.prisma.metricDefinition.findMany({
        where: { key: { in: dto.metricKeys } },
        select: { key: true },
      });
      const existingKeys = new Set(existing.map((m) => m.key));
      const invalid = dto.metricKeys.filter((k) => !existingKeys.has(k));
      if (invalid.length) {
        throw new BadRequestException(
          `Unknown metric keys: ${invalid.join(', ')}`,
        );
      }
    }

    const userIds = dto.userIds ?? undefined;
    if (userIds !== undefined && userIds.length > 0) {
      const users = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, role: true, shipId: true },
      });
      const foundIds = new Set(users.map((u) => u.id));
      const missing = userIds.filter((uid) => !foundIds.has(uid));
      if (missing.length) {
        throw new BadRequestException(
          `User(s) not found: ${missing.join(', ')}`,
        );
      }
      const notAssignable = users.filter(
        (u) => u.role !== 'user' || (u.shipId != null && u.shipId !== id),
      );
      if (notAssignable.length) {
        throw new BadRequestException(
          'Only users with role "user" can be assigned; some are already on another ship',
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const updateData: Parameters<typeof tx.ship.update>[0]['data'] = {};
      if (dto.name !== undefined) updateData.name = dto.name;
      if (dto.serialNumber !== undefined)
        updateData.serialNumber = dto.serialNumber;
      if (Object.keys(updateData).length) {
        await tx.ship.update({ where: { id }, data: updateData });
      }
      if (dto.metricKeys !== undefined) {
        await tx.shipMetricsConfig.deleteMany({ where: { shipId: id } });
        if (dto.metricKeys.length) {
          await tx.shipMetricsConfig.createMany({
            data: dto.metricKeys.map((metricKey) => ({
              shipId: id,
              metricKey,
              isActive: true,
            })),
          });
        }
      }
      if (userIds !== undefined) {
        await tx.user.updateMany({
          where: { shipId: id },
          data: { shipId: null },
        });
        if (userIds.length) {
          await tx.user.updateMany({
            where: { id: { in: userIds } },
            data: { shipId: id },
          });
        }
      }
    });

    return this.findOne(id);
  }

  async remove(id: string) {
    const ship = await this.prisma.ship.findUnique({ where: { id } });
    if (!ship) throw new NotFoundException('Ship not found');

    // If ship has RAGFlow dataset, must delete it from RAGFlow first
    if (ship.ragflowDatasetId) {
      if (!this.ragflow.isConfigured()) {
        throw new ServiceUnavailableException(
          'RAGFlow service is not available',
        );
      }
      try {
        await this.ragflow.deleteDataset(ship.ragflowDatasetId);
      } catch (error) {
        throw new ServiceUnavailableException(
          `Failed to delete dataset from RAGFlow: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.prisma.ship.delete({ where: { id } });
  }
}
