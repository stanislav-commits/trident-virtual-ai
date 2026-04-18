import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RagflowService } from '../ragflow/ragflow.service';
import { MetricsService } from '../telemetry-catalog/metrics.service';
import { CreateShipDto } from './dto/create-ship.dto';
import { UpdateShipDto } from './dto/update-ship.dto';

const TAG_SUMMARY_SELECT = {
  id: true,
  key: true,
  category: true,
  subcategory: true,
  item: true,
  description: true,
} as const;

@Injectable()
export class ShipsService {
  private readonly logger = new Logger(ShipsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ragflow: RagflowService,
    private readonly metricsService: MetricsService,
  ) {}

  async getMetricDefinitions() {
    const metrics = await this.prisma.metricDefinition.findMany({
      orderBy: { key: 'asc' },
      select: {
        key: true,
        label: true,
        description: true,
        unit: true,
        bucket: true,
        measurement: true,
        field: true,
        status: true,
        dataType: true,
        tags: {
          take: 1,
          orderBy: {
            tag: { key: 'asc' },
          },
          select: {
            tag: {
              select: TAG_SUMMARY_SELECT,
            },
          },
        },
      },
    });

    return metrics.map(({ tags, ...metric }) => ({
      ...metric,
      tag: tags[0]?.tag ?? null,
    }));
  }

  async listOrganizations() {
    return this.metricsService.listOrganizations();
  }

  async create(dto: CreateShipDto) {
    const name = dto.name?.trim();
    if (!name) {
      throw new BadRequestException('name is required');
    }

    const organizationName = dto.organizationName?.trim();
    if (!organizationName) {
      throw new BadRequestException('organizationName is required');
    }

    const requestedMetricKeys = this.normalizeMetricKeys(dto.metricKeys);
    const imoNumber = this.normalizeOptionalText(
      dto.imoNumber,
      'imoNumber',
      20,
    );
    const flag = this.normalizeOptionalText(dto.flag, 'flag', 100);
    const buildYear = this.normalizeOptionalBuildYear(dto.buildYear);
    const lengthOverall = this.normalizeOptionalMeasurement(
      dto.lengthOverall,
      'lengthOverall',
    );
    const beam = this.normalizeOptionalMeasurement(dto.beam, 'beam');
    const deadweight = this.normalizeOptionalInteger(
      dto.deadweight,
      'deadweight',
    );
    const grossTonnage = this.normalizeOptionalInteger(
      dto.grossTonnage,
      'grossTonnage',
    );
    const buildYard = this.normalizeOptionalText(
      dto.buildYard,
      'buildYard',
      255,
    );
    const shipClass = this.normalizeOptionalText(
      dto.shipClass,
      'shipClass',
      255,
    );
    await this.ensureOrganizationExists(organizationName);

    const userIds = dto.userIds ?? [];
    await this.validateUserAssignments(userIds);

    const ship = await this.prisma.ship.create({
      data: {
        name,
        organizationName,
        imoNumber: imoNumber ?? null,
        flag: flag ?? null,
        buildYear: buildYear ?? null,
        lengthOverall: lengthOverall ?? null,
        beam: beam ?? null,
        deadweight: deadweight ?? null,
        grossTonnage: grossTonnage ?? null,
        buildYard: buildYard ?? null,
        shipClass: shipClass ?? null,
        metricsSyncStatus: 'pending',
        metricsSyncError: null,
        metricsSyncedAt: null,
      },
      include: {
        metricsConfig: { select: { metricKey: true, isActive: true } },
        assignedUsers: { select: { id: true, userId: true, name: true } },
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

    await this.metricsService.enqueueShipMetricsSync(ship.id, organizationName, {
      activeMetricKeys:
        requestedMetricKeys !== undefined ? requestedMetricKeys : undefined,
    });

    return this.findOne(ship.id);
  }

  async findAll() {
    return this.prisma.ship.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        metricsConfig: { select: { metricKey: true, isActive: true } },
        assignedUsers: { select: { id: true, userId: true, name: true } },
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
              select: {
                key: true,
                label: true,
                description: true,
                unit: true,
                bucket: true,
                measurement: true,
                field: true,
                status: true,
              },
            },
          },
        },
        assignedUsers: { select: { id: true, userId: true, name: true } },
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

    const nextName = dto.name?.trim();
    const requestedMetricKeys = this.normalizeMetricKeys(dto.metricKeys);
    const nextOrganizationName = dto.organizationName?.trim();
    const nextImoNumber = this.normalizeOptionalText(
      dto.imoNumber,
      'imoNumber',
      20,
    );
    const nextFlag = this.normalizeOptionalText(dto.flag, 'flag', 100);
    const nextBuildYear = this.normalizeOptionalBuildYear(dto.buildYear);
    const nextLengthOverall = this.normalizeOptionalMeasurement(
      dto.lengthOverall,
      'lengthOverall',
    );
    const nextBeam = this.normalizeOptionalMeasurement(dto.beam, 'beam');
    const nextDeadweight = this.normalizeOptionalInteger(
      dto.deadweight,
      'deadweight',
    );
    const nextGrossTonnage = this.normalizeOptionalInteger(
      dto.grossTonnage,
      'grossTonnage',
    );
    const nextBuildYard = this.normalizeOptionalText(
      dto.buildYard,
      'buildYard',
      255,
    );
    const nextShipClass = this.normalizeOptionalText(
      dto.shipClass,
      'shipClass',
      255,
    );

    if (
      nextOrganizationName &&
      nextOrganizationName !== ship.organizationName
    ) {
      await this.ensureOrganizationExists(nextOrganizationName);
    }

    const userIds = dto.userIds ?? undefined;
    if (userIds !== undefined) {
      await this.validateUserAssignments(userIds, id);
    }

    await this.prisma.$transaction(async (tx) => {
      const updateData: Parameters<typeof tx.ship.update>[0]['data'] = {};
      if (nextName !== undefined) updateData.name = nextName;
      if (nextOrganizationName !== undefined) {
        updateData.organizationName = nextOrganizationName;
        if (nextOrganizationName !== ship.organizationName) {
          updateData.metricsSyncStatus = 'pending';
          updateData.metricsSyncError = null;
          updateData.metricsSyncedAt = null;
        }
      }
      if (nextImoNumber !== undefined) updateData.imoNumber = nextImoNumber;
      if (nextFlag !== undefined) updateData.flag = nextFlag;
      if (nextBuildYear !== undefined) updateData.buildYear = nextBuildYear;
      if (nextLengthOverall !== undefined) {
        updateData.lengthOverall = nextLengthOverall;
      }
      if (nextBeam !== undefined) updateData.beam = nextBeam;
      if (nextDeadweight !== undefined) updateData.deadweight = nextDeadweight;
      if (nextGrossTonnage !== undefined) {
        updateData.grossTonnage = nextGrossTonnage;
      }
      if (nextBuildYard !== undefined) updateData.buildYard = nextBuildYard;
      if (nextShipClass !== undefined) updateData.shipClass = nextShipClass;
      if (Object.keys(updateData).length > 0) {
        await tx.ship.update({ where: { id }, data: updateData });
      }

      if (
        nextOrganizationName &&
        nextOrganizationName !== ship.organizationName
      ) {
        await tx.shipMetricsConfig.deleteMany({
          where: { shipId: id },
        });
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

    if (
      nextOrganizationName &&
      nextOrganizationName !== ship.organizationName
    ) {
      await this.metricsService.enqueueShipMetricsSync(id, nextOrganizationName, {
        activeMetricKeys:
          requestedMetricKeys !== undefined ? requestedMetricKeys : undefined,
      });
    } else if (requestedMetricKeys !== undefined) {
      await this.metricsService.setShipMetricActivity(id, requestedMetricKeys);
    }

    return this.findOne(id);
  }

  async remove(id: string) {
    const ship = await this.prisma.ship.findUnique({ where: { id } });
    if (!ship) throw new NotFoundException('Ship not found');

    if (ship.ragflowDatasetId) {
      if (!this.ragflow.isConfigured()) {
        throw new ServiceUnavailableException(
          'RAGFlow service is not available',
        );
      }
      try {
        await this.ragflow.deleteDataset(ship.ragflowDatasetId);
      } catch (error) {
        this.logger.warn(
          `RAGFlow dataset deletion failed for ship ${id}, proceeding with DB removal: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await this.prisma.ship.delete({ where: { id } });
  }

  private normalizeMetricKeys(metricKeys?: string[]) {
    if (metricKeys === undefined) {
      return undefined;
    }

    return [
      ...new Set(
        metricKeys.map((metricKey) => metricKey.trim()).filter(Boolean),
      ),
    ];
  }

  private normalizeOptionalText(
    value: unknown,
    fieldName: string,
    maxLength: number,
  ): string | null | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (value === null) {
      return null;
    }

    const normalized = String(value).trim();
    if (!normalized) {
      return null;
    }

    if (normalized.length > maxLength) {
      throw new BadRequestException(
        `${fieldName} must be ${maxLength} characters or fewer`,
      );
    }

    return normalized;
  }

  private normalizeOptionalInteger(
    value: unknown,
    fieldName: string,
  ): number | null | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (value === null || value === '') {
      return null;
    }

    const parsed =
      typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
      throw new BadRequestException(
        `${fieldName} must be a non-negative whole number`,
      );
    }

    return parsed;
  }

  private normalizeOptionalBuildYear(
    value: unknown,
  ): number | null | undefined {
    const parsed = this.normalizeOptionalInteger(value, 'buildYear');
    if (parsed == null) {
      return parsed;
    }

    if (parsed < 1800 || parsed > 3000) {
      throw new BadRequestException(
        'buildYear must be a valid four-digit year',
      );
    }

    return parsed;
  }

  private normalizeOptionalMeasurement(
    value: unknown,
    fieldName: string,
  ): number | null | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (value === null || value === '') {
      return null;
    }

    const parsed =
      typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new BadRequestException(
        `${fieldName} must be a non-negative number`,
      );
    }

    return parsed;
  }

  private async ensureOrganizationExists(organizationName: string) {
    const organizations = await this.metricsService.listOrganizations();
    if (!organizations.includes(organizationName)) {
      throw new BadRequestException(
        `Unknown organization: ${organizationName}`,
      );
    }
  }

  private async validateUserAssignments(
    userIds: string[],
    currentShipId?: string,
  ) {
    if (!userIds.length) return;

    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, role: true, shipId: true },
    });
    const foundIds = new Set(users.map((user) => user.id));
    const missingUserIds = userIds.filter((userId) => !foundIds.has(userId));
    if (missingUserIds.length) {
      throw new BadRequestException(
        `User(s) not found: ${missingUserIds.join(', ')}`,
      );
    }

    const nonAssignableUsers = users.filter(
      (user) =>
        user.role !== 'user' ||
        (user.shipId != null && user.shipId !== currentShipId),
    );
    if (nonAssignableUsers.length) {
      throw new BadRequestException(
        'Only users with role "user" can be assigned; some are already on another ship',
      );
    }
  }
}
