import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { formatError } from '../../common/utils/error.utils';
import {
  LlmUsageQueryService,
  UsageFilter,
} from '../llm-usage/llm-usage-query.service';
import { ShipEntity } from '../ships/entities/ship.entity';
import { PLATFORM_SHIP_ID } from '../ships/platform-ship.constants';
import { AlertsAggregator } from './aggregators/alerts.aggregator';
import { AssetsOverviewAggregator } from './aggregators/assets.aggregator';
import { ComplianceAggregator } from './aggregators/compliance.aggregator';
import { CrewAggregator } from './aggregators/crew.aggregator';
import { InventoryAggregator } from './aggregators/inventory.aggregator';
import { KnowledgeAggregator } from './aggregators/knowledge.aggregator';
import { MaintenanceAggregator } from './aggregators/maintenance.aggregator';
import { MetricsOverviewAggregator } from './aggregators/metrics.aggregator';
import { TasksAggregator } from './aggregators/tasks.aggregator';
import {
  OverviewCard,
  OverviewTokens,
  OverviewVessel,
  ShipOverviewResponse,
} from './overview.types';

/**
 * A domain that has not answered by now is treated as broken. The Overview is
 * the page an admin opens to find out what is wrong; making them wait on a
 * pathological query defeats it, and every aggregate here is one statement over
 * a single vessel's rows, so seconds are already far beyond normal.
 */
const AGGREGATOR_TIMEOUT_MS = 10_000;

/**
 * How many aggregates may hold a database connection at once. Three leaves room
 * in the ten-connection default pool for the rest of the app while still keeping
 * the page well under a second on real data.
 */
const SLOT_CONCURRENCY = 3;

/**
 * A card's identity, held here as well as in the aggregator, so a domain that
 * rejects or never answers still leaves a labelled tile in its place instead of
 * silently shortening the page.
 */
interface AggregatorSlot {
  key: string;
  title: string;
  headlineLabel: string;
  section: string | null;
  collect: (shipId: string) => Promise<OverviewCard>;
}

/**
 * Assembles the per-vessel Overview page.
 *
 * The nine domains are unrelated aggregates over unrelated tables, so they run
 * concurrently and settle individually: the page an admin opens to find out what
 * is broken must not go blank because one domain is broken. A domain that
 * rejects or stalls becomes a card with `headline: null` and a `degraded`
 * reason — never 0, which an admin would read as "nothing is wrong here".
 */
@Injectable()
export class OverviewService {
  private readonly logger = new Logger(OverviewService.name);

  constructor(
    @InjectRepository(ShipEntity)
    private readonly shipRepository: Repository<ShipEntity>,
    private readonly assetsAggregator: AssetsOverviewAggregator,
    private readonly complianceAggregator: ComplianceAggregator,
    private readonly maintenanceAggregator: MaintenanceAggregator,
    private readonly tasksAggregator: TasksAggregator,
    private readonly crewAggregator: CrewAggregator,
    private readonly inventoryAggregator: InventoryAggregator,
    private readonly alertsAggregator: AlertsAggregator,
    private readonly knowledgeAggregator: KnowledgeAggregator,
    private readonly metricsAggregator: MetricsOverviewAggregator,
    private readonly usageQuery: LlmUsageQueryService,
  ) {}

  async getShipOverview(shipId: string): Promise<ShipOverviewResponse> {
    const ship = await this.shipRepository.findOne({ where: { id: shipId } });
    if (!ship) {
      throw new NotFoundException(`Ship ${shipId} not found`);
    }

    const slots = this.slots();
    const settled = await this.runSlots(slots, shipId);

    const cards = settled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const reason = formatError(result.reason);
      this.logger.warn(
        `Overview card '${slots[index].key}' failed for ship ${shipId}: ${reason}`,
      );
      return this.degradedCard(slots[index], reason);
    });

    // Spend is read outside the card fan-out: it is one cheap indexed query, and
    // a failure here must not cost the page its nine cards.
    let tokens = null;
    try {
      tokens = await this.usageQuery.monthToDate(shipId);
    } catch (error) {
      this.logger.warn(
        `Overview token usage unavailable for ship ${shipId}: ${formatError(error)}`,
      );
    }

    return {
      shipId: ship.id,
      generatedAt: new Date().toISOString(),
      vessel: this.toVessel(ship),
      cards,
      tokens,
    };
  }

  /**
   * Spend alone, for a window the operator chose. Separate from the page load so
   * changing the period does not re-run nine aggregates that do not depend on it.
   */
  async getShipSpend(
    shipId: string,
    from: Date | null,
    to: Date | null,
    filter: UsageFilter = {},
  ): Promise<OverviewTokens | null> {
    const exists = await this.shipRepository.exist({ where: { id: shipId } });
    if (!exists) {
      throw new NotFoundException(`Ship ${shipId} not found`);
    }
    if (to && from && to <= from) {
      throw new BadRequestException('to must be after from');
    }
    // No explicit start means month to date — the window the page opens with.
    const start = from ?? startOfUtcMonth();
    return this.usageQuery.range(shipId, start, to, filter);
  }

  /**
   * Deliberately NOT nine queries at once. The pool is node-postgres' default of
   * ten connections, so a single unthrottled page took nine of them and two
   * admins with this page open could queue chat, PMS and everything else behind
   * them — worst during an import, which is exactly when someone opens it.
   * Results stay in slot order regardless of completion order.
   */
  private async runSlots(
    slots: AggregatorSlot[],
    shipId: string,
  ): Promise<PromiseSettledResult<OverviewCard>[]> {
    const results: PromiseSettledResult<OverviewCard>[] = new Array(
      slots.length,
    );
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= slots.length) return;
        const [settled] = await Promise.allSettled([
          this.runSlot(slots[index], shipId),
        ]);
        results[index] = settled;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SLOT_CONCURRENCY, slots.length) }, worker),
    );
    return results;
  }

  /** The contract's card order; the array position is the position on the page. */
  private slots(): AggregatorSlot[] {
    return [
      {
        key: 'assets',
        title: 'Asset register',
        headlineLabel: 'assets',
        section: 'assets',
        collect: (shipId) => this.assetsAggregator.collect(shipId),
      },
      {
        key: 'compliance',
        title: 'Compliance documents',
        headlineLabel: 'documents held',
        section: 'compliance',
        collect: (shipId) => this.complianceAggregator.collect(shipId),
      },
      {
        key: 'maintenance',
        title: 'Maintenance plan',
        headlineLabel: 'open tasks',
        section: 'maintenance',
        collect: (shipId) => this.maintenanceAggregator.collect(shipId),
      },
      {
        key: 'tasks',
        title: 'Tasks',
        headlineLabel: 'open tasks',
        section: 'tasks',
        collect: (shipId) => this.tasksAggregator.collect(shipId),
      },
      {
        key: 'crew',
        title: 'Crew',
        headlineLabel: 'active crew',
        section: 'crew',
        collect: (shipId) => this.crewAggregator.collect(shipId),
      },
      {
        key: 'inventory',
        title: 'Inventory',
        headlineLabel: 'items tracked',
        section: 'inventory',
        collect: (shipId) => this.inventoryAggregator.collect(shipId),
      },
      {
        key: 'alerts',
        title: 'Alerts',
        headlineLabel: 'firing equipment alarms',
        section: 'alerts',
        collect: (shipId) => this.alertsAggregator.collect(shipId),
      },
      {
        key: 'knowledge',
        title: 'Knowledge base',
        headlineLabel: 'documents',
        section: 'documents',
        collect: (shipId) => this.knowledgeAggregator.collect(shipId),
      },
      {
        key: 'metrics',
        title: 'Metrics catalog',
        headlineLabel: 'catalog metrics',
        section: 'metrics',
        collect: (shipId) => this.metricsAggregator.collect(shipId),
      },
    ];
  }

  /**
   * An aggregator is contracted never to throw, so a rejection here is a bug or
   * a database problem rather than a handled gap — either way it must stay
   * inside its own card. The timeout only stops this request waiting; the query
   * itself keeps running on the connection until Postgres is done with it.
   */
  private async runSlot(
    slot: AggregatorSlot,
    shipId: string,
  ): Promise<OverviewCard> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        slot.collect(shipId),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  `no answer within ${AGGREGATOR_TIMEOUT_MS} ms (the query may still be running on the database)`,
                ),
              ),
            AGGREGATOR_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private degradedCard(slot: AggregatorSlot, reason: string): OverviewCard {
    return {
      key: slot.key,
      title: slot.title,
      headline: null,
      headlineLabel: slot.headlineLabel,
      stats: [],
      notes: [
        `${slot.title} could not be aggregated for this vessel. Nothing on this tile is a count of anything — read it as unknown, not as zero.`,
      ],
      section: slot.section,
      degraded: {
        reason: `${slot.title} aggregation failed: ${reason}`,
        affects: [slot.headlineLabel, 'every stat on this card'],
      },
    };
  }

  private toVessel(ship: ShipEntity): OverviewVessel {
    return {
      name: ship.name,
      imoNumber: ship.imoNumber,
      flag: ship.flag,
      classSociety: ship.classSociety,
      buildYear: ship.buildYear,
      lengthM: numericToNumber(ship.lengthM),
      grossTonnage: ship.grossTonnage,
      homePort: ship.homePort,
      callSign: ship.callSign,
      mmsi: ship.mmsi,
      shipyard: ship.shipyard,
      operationType: ship.operationType,
      fleetManagerEmail: ship.fleetManagerEmail,
      hasPhoto: ship.photoProvider != null,
      // The flag is the source of truth, but the id is fixed in migrations and
      // referenced without a lookup — either one marks the Publications scope,
      // which must never be presented as a vessel.
      isPlatform: ship.isPlatform || ship.id === PLATFORM_SHIP_ID,
    };
  }
}

function startOfUtcMonth(): Date {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return start;
}

/** TypeORM hands `numeric` columns back as strings, and Number(null) is 0. */
function numericToNumber(value: string | null): number | null {
  if (value === null || value.trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
