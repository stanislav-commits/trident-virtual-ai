import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateShipDto } from './dto/create-ship.dto';
import { UpdateShipDto } from './dto/update-ship.dto';

@Injectable()
export class ShipsService {
  constructor(private readonly prisma: PrismaService) {}

  async getMetricDefinitions() {
    return this.prisma.metricDefinition.findMany({
      orderBy: { key: 'asc' },
      select: { key: true, label: true, unit: true, dataType: true },
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
      },
    });
    return ship;
  }

  async findAll() {
    return this.prisma.ship.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        metricsConfig: { select: { metricKey: true, isActive: true } },
      },
    });
  }

  async findOne(id: string) {
    const ship = await this.prisma.ship.findUnique({
      where: { id },
      include: {
        metricsConfig: {
          select: { metricKey: true, isActive: true },
          include: { metric: { select: { key: true, label: true, unit: true } } },
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
    });

    return this.findOne(id);
  }

  async remove(id: string) {
    const ship = await this.prisma.ship.findUnique({ where: { id } });
    if (!ship) throw new NotFoundException('Ship not found');
    await this.prisma.ship.delete({ where: { id } });
  }
}
