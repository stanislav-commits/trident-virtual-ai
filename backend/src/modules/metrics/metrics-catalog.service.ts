import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository, SelectQueryBuilder } from 'typeorm';
import {
  InfluxMetricDefinition,
  InfluxService,
} from '../../integrations/influx/influx.service';
import { ShipEntity } from '../ships/entities/ship.entity';
import { ListShipMetricCatalogQueryDto } from './dto/list-ship-metric-catalog-query.dto';
import { ToggleShipMetricsDto } from './dto/toggle-ship-metrics.dto';
import { ShipMetricCatalogEntity } from './entities/ship-metric-catalog.entity';
import { MetricDescriptionBackfillService } from './metric-description-backfill.service';
import { MetricsSemanticBootstrapResultDto, MetricsSemanticBootstrapService } from './metrics-semantic-bootstrap.service';
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
  isEnabled: boolean;
  syncedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShipMetricBucketGroupDto {
  bucket: string;
  metrics: ShipMetricCatalogItemDto[];
  totalMetrics: number;
}

export interface ShipMetricCatalogBucketOptionDto {
  bucket: string;
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

export interface ShipMetricCatalogPageDto {
  ship: {
    id: string;
    name: string;
    organizationName: string | null;
  };
  totalMetrics: number;
  filteredMetrics: number;
  syncedAt: string | null;
  page: number;
  pageSize: number;
  totalPages: number;
  buckets: ShipMetricCatalogBucketOptionDto[];
  items: ShipMetricCatalogItemDto[];
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
  semanticBootstrap: Pick<
    MetricsSemanticBootstrapResultDto,
    'totalMetrics' | 'conceptsCreated' | 'conceptsUpdated' | 'membersAdded' | 'skippedBindings'
  > | null;
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
    private readonly metricsSemanticBootstrapService: MetricsSemanticBootstrapService,
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

    const semanticBootstrap = await this.metricsSemanticBootstrapService.bootstrapShipCatalog(
      ship.id,
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
      semanticBootstrap: {
        totalMetrics: semanticBootstrap.totalMetrics,
        conceptsCreated: semanticBootstrap.conceptsCreated,
        conceptsUpdated: semanticBootstrap.conceptsUpdated,
        membersAdded: semanticBootstrap.membersAdded,
        skippedBindings: semanticBootstrap.skippedBindings,
      },
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

  async listShipCatalogPage(
    shipId: string,
    query: ListShipMetricCatalogQueryDto,
  ): Promise<ShipMetricCatalogPageDto> {
    const ship = await this.findRequiredShip(shipId);
    const bucketFilter = this.normalizeBucketFilter(query.bucket);
    const searchQuery = query.search?.trim() ?? '';
    const pageSize = query.pageSize ?? 25;
    const requestedPage = query.page ?? 1;

    const totalMetricsPromise = this.shipMetricCatalogRepository.count({
      where: { shipId },
    });
    const filteredMetricsPromise = this.applyCatalogFilters(
      this.shipMetricCatalogRepository.createQueryBuilder('entry'),
      shipId,
      {
        bucket: bucketFilter,
        search: searchQuery,
      },
    ).getCount();
    const bucketOptionsPromise = this.shipMetricCatalogRepository
      .createQueryBuilder('entry')
      .select('entry.bucket', 'bucket')
      .addSelect('COUNT(entry.id)', 'totalMetrics')
      .where('entry.shipId = :shipId', { shipId })
      .groupBy('entry.bucket')
      .orderBy('entry.bucket', 'ASC')
      .getRawMany<{ bucket: string; totalMetrics: string }>();
    const latestSyncedAtPromise = this.shipMetricCatalogRepository
      .createQueryBuilder('entry')
      .select('MAX(entry.syncedAt)', 'syncedAt')
      .where('entry.shipId = :shipId', { shipId })
      .getRawOne<{ syncedAt: string | null }>();

    const [totalMetrics, filteredMetrics, bucketOptionsRaw, latestSyncedAtRaw] =
      await Promise.all([
        totalMetricsPromise,
        filteredMetricsPromise,
        bucketOptionsPromise,
        latestSyncedAtPromise,
      ]);

    const totalPages = Math.max(1, Math.ceil(filteredMetrics / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const entries = await this.applyCatalogFilters(
      this.shipMetricCatalogRepository.createQueryBuilder('entry'),
      shipId,
      {
        bucket: bucketFilter,
        search: searchQuery,
      },
    )
      .orderBy('entry.bucket', 'ASC')
      .addOrderBy('entry.key', 'ASC')
      .addOrderBy('entry.field', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getMany();

    return {
      ship: {
        id: ship.id,
        name: ship.name,
        organizationName: ship.organizationName,
      },
      totalMetrics,
      filteredMetrics,
      syncedAt: latestSyncedAtRaw?.syncedAt
        ? new Date(latestSyncedAtRaw.syncedAt).toISOString()
        : null,
      page,
      pageSize,
      totalPages,
      buckets: bucketOptionsRaw.map((bucketOption) => ({
        bucket: bucketOption.bucket,
        totalMetrics: Number(bucketOption.totalMetrics),
      })),
      items: entries.map((entry) => this.serializeEntry(entry)),
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

  private normalizeBucketFilter(bucket?: string): string | null {
    const normalizedBucket = bucket?.trim();

    if (!normalizedBucket || normalizedBucket.toLowerCase() === 'all') {
      return null;
    }

    return normalizedBucket;
  }

  private applyCatalogFilters(
    queryBuilder: SelectQueryBuilder<ShipMetricCatalogEntity>,
    shipId: string,
    filters: {
      bucket: string | null;
      search: string;
    },
  ): SelectQueryBuilder<ShipMetricCatalogEntity> {
    queryBuilder.where('entry.shipId = :shipId', { shipId });

    if (filters.bucket) {
      queryBuilder.andWhere('entry.bucket = :bucket', {
        bucket: filters.bucket,
      });
    }

    if (filters.search) {
      const search = `%${filters.search}%`;

      queryBuilder.andWhere(
        new Brackets((qb) => {
          qb.where('entry.bucket ILIKE :search', { search })
            .orWhere('entry.key ILIKE :search', { search })
            .orWhere('entry.field ILIKE :search', { search })
            .orWhere('COALESCE(entry.description, \'\') ILIKE :search', {
              search,
            });
        }),
      );
    }

    return queryBuilder;
  }

  async toggleShipMetrics(
    shipId: string,
    dto: ToggleShipMetricsDto,
  ): Promise<{ updated: number }> {
    await this.findRequiredShip(shipId);

    if (dto.metricIds?.length) {
      const result = await this.shipMetricCatalogRepository.update(
        { id: In(dto.metricIds), shipId },
        { isEnabled: dto.isEnabled },
      );
      return { updated: result.affected ?? 0 };
    }

    const result = await this.shipMetricCatalogRepository.update(
      { shipId },
      { isEnabled: dto.isEnabled },
    );
    return { updated: result.affected ?? 0 };
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
      isEnabled: entry.isEnabled,
      syncedAt: entry.syncedAt.toISOString(),
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    };
  }
}
