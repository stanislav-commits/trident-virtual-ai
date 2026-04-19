import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  InfluxMetricDefinition,
  InfluxService,
} from '../../integrations/influx/influx.service';
import { ShipEntity } from '../ships/entities/ship.entity';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { MetricDescriptionBackfillService } from './metric-description-backfill.service';
import {
  normalizeMetricDescription,
  shouldBackfillMetricDescription,
} from './metric-description.utils';

export interface ShipMetricCatalogItemDto {
  id: string;
  key: string;
  bucket: string;
  field: string;
  description: string | null;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShipMetricBucketGroupDto {
  bucket: string;
  metrics: ShipMetricCatalogItemDto[];
  totalMetrics: number;
}

export interface ShipMetricsCatalogDto {
  ship: {
    id: string;
    name: string;
    organizationName: string | null;
  };
  totalMetrics: number;
  syncedAt: string | null;
  buckets: ShipMetricBucketGroupDto[];
}

export interface ShipMetricCatalogSyncResultDto {
  shipId: string;
  shipName: string;
  organizationName: string;
  bucketCount: number;
  buckets: string[];
  metricsSynced: number;
  descriptionsQueued: number;
  staleMetricsRemoved: number;
  syncedAt: string;
}

@Injectable()
export class MetricsCatalogService {
  private readonly logger = new Logger(MetricsCatalogService.name);

  constructor(
    @InjectRepository(ShipEntity)
    private readonly shipsRepository: Repository<ShipEntity>,
    @InjectRepository(ShipMetricCatalogEntity)
    private readonly shipMetricCatalogRepository: Repository<ShipMetricCatalogEntity>,
    private readonly influxService: InfluxService,
    private readonly metricDescriptionBackfillService: MetricDescriptionBackfillService,
  ) {}

  async discoverOrganizationMetrics(
    organizationName: string,
  ): Promise<InfluxMetricDefinition[]> {
    const normalizedOrganizationName = organizationName.trim();

    if (!normalizedOrganizationName) {
      throw new BadRequestException(
        'organizationName is required to discover metrics',
      );
    }

    try {
      return await this.influxService.listAllMetrics(normalizedOrganizationName);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Metric discovery failed';

      if (/organization name .* not found/i.test(errorMessage)) {
        throw new BadRequestException(
          `Influx organization "${normalizedOrganizationName}" was not found`,
        );
      }

      throw new BadRequestException(
        `Failed to discover metrics for organization "${normalizedOrganizationName}"`,
      );
    }
  }

  async syncShipCatalog(
    shipId: string,
    discoveredMetrics?: InfluxMetricDefinition[],
  ): Promise<ShipMetricCatalogSyncResultDto> {
    const ship = await this.findRequiredShip(shipId);
    const organizationName = ship.organizationName?.trim() ?? '';

    if (!organizationName) {
      throw new BadRequestException(
        'Ship organization is required to sync metrics',
      );
    }

    const metrics =
      discoveredMetrics ?? (await this.discoverOrganizationMetrics(organizationName));
    const uniqueMetrics = [...new Map(metrics.map((metric) => [metric.key, metric])).values()].sort(
      (left, right) =>
        left.bucket.localeCompare(right.bucket) ||
        left.key.localeCompare(right.key) ||
        left.field.localeCompare(right.field),
    );
    const syncedAt = new Date();

    const existingEntries = await this.shipMetricCatalogRepository.find({
      where: { shipId },
      order: { bucket: 'ASC', key: 'ASC', field: 'ASC' },
    });

    const existingByKey = new Map(
      existingEntries.map((entry) => [entry.key, entry]),
    );
    const desiredKeys = new Set(uniqueMetrics.map((metric) => metric.key));

    const entitiesToSave: ShipMetricCatalogEntity[] = [];
    let descriptionsQueued = 0;

    for (const metric of uniqueMetrics) {
      const existingEntry = existingByKey.get(metric.key);
      const existingDescription = normalizeMetricDescription(
        existingEntry?.description,
      );
      const shouldQueueDescription = shouldBackfillMetricDescription(
        existingDescription,
      );

      if (shouldQueueDescription) {
        descriptionsQueued += 1;
      }

      entitiesToSave.push(
        this.shipMetricCatalogRepository.create({
          id: existingEntry?.id,
          shipId,
          key: metric.key,
          bucket: metric.bucket,
          field: metric.field,
          description: shouldQueueDescription ? null : existingDescription,
          syncedAt,
        }),
      );
    }

    if (entitiesToSave.length > 0) {
      await this.shipMetricCatalogRepository.save(entitiesToSave);
    }

    const staleMetricIds = existingEntries
      .filter((entry) => !desiredKeys.has(entry.key))
      .map((entry) => entry.id);

    if (staleMetricIds.length > 0) {
      await this.shipMetricCatalogRepository.delete(staleMetricIds);
    }

    if (descriptionsQueued > 0) {
      this.metricDescriptionBackfillService.scheduleBackfill('ship-sync');
    }

    this.logger.log(
      `Synced ${uniqueMetrics.length} metrics for ship ${ship.id} (${organizationName}) across ${new Set(uniqueMetrics.map((metric) => metric.bucket)).size} buckets; descriptions queued: ${descriptionsQueued}`,
    );

    return {
      shipId: ship.id,
      shipName: ship.name,
      organizationName,
      bucketCount: new Set(uniqueMetrics.map((metric) => metric.bucket)).size,
      buckets: [...new Set(uniqueMetrics.map((metric) => metric.bucket))],
      metricsSynced: uniqueMetrics.length,
      descriptionsQueued,
      staleMetricsRemoved: staleMetricIds.length,
      syncedAt: syncedAt.toISOString(),
    };
  }

  async listShipCatalog(shipId: string): Promise<ShipMetricsCatalogDto> {
    const ship = await this.findRequiredShip(shipId);
    const entries = await this.shipMetricCatalogRepository.find({
      where: { shipId },
      order: {
        bucket: 'ASC',
        key: 'ASC',
        field: 'ASC',
      },
    });

    const groupedBuckets = new Map<string, ShipMetricBucketGroupDto>();

    for (const entry of entries) {
      const serializedEntry = this.serializeEntry(entry);
      const existingGroup = groupedBuckets.get(entry.bucket);

      if (existingGroup) {
        existingGroup.metrics.push(serializedEntry);
        existingGroup.totalMetrics += 1;
        continue;
      }

      groupedBuckets.set(entry.bucket, {
        bucket: entry.bucket,
        metrics: [serializedEntry],
        totalMetrics: 1,
      });
    }

    const latestSyncedAt = entries.reduce<Date | null>((latest, entry) => {
      if (!latest || entry.syncedAt > latest) {
        return entry.syncedAt;
      }

      return latest;
    }, null);

    return {
      ship: {
        id: ship.id,
        name: ship.name,
        organizationName: ship.organizationName,
      },
      totalMetrics: entries.length,
      syncedAt: latestSyncedAt?.toISOString() ?? null,
      buckets: [...groupedBuckets.values()],
    };
  }

  async updateMetricDescription(
    metricId: string,
    description?: string | null,
  ): Promise<ShipMetricCatalogItemDto> {
    const metric = await this.shipMetricCatalogRepository.findOne({
      where: { id: metricId },
    });

    if (!metric) {
      throw new NotFoundException('Ship metric catalog entry not found');
    }

    metric.description = normalizeMetricDescription(description);

    const savedEntry = await this.shipMetricCatalogRepository.save(metric);
    return this.serializeEntry(savedEntry);
  }

  private async findRequiredShip(shipId: string): Promise<ShipEntity> {
    const ship = await this.shipsRepository.findOne({ where: { id: shipId } });

    if (!ship) {
      throw new NotFoundException('Ship not found');
    }

    return ship;
  }

  private serializeEntry(
    entry: ShipMetricCatalogEntity,
  ): ShipMetricCatalogItemDto {
    return {
      id: entry.id,
      key: entry.key,
      bucket: entry.bucket,
      field: entry.field,
      description: entry.description,
      syncedAt: entry.syncedAt.toISOString(),
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    };
  }
}
