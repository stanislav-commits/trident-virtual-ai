import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { formatError } from '../../../common/utils/error.utils';
import { OverviewCard, OverviewStatTone } from '../overview.types';

/**
 * Width of the "approaching minimum" band, as a multiple of stock_min. A chosen
 * convention, not a configured reorder point — single-sourced here so the SQL
 * and the note that discloses it to the admin cannot drift apart.
 */
const APPROACHING_BAND = 1.25;

/**
 * Row shape of the single aggregate below. Every count is cast to int4 because
 * pg hands COUNT back as a bigint string.
 */
interface StockCounts {
  total: number;
  /** stock_min above zero — the only items any low-stock check can see. */
  with_min: number;
  out_of_stock: number;
  below_min: number;
  approaching_min: number;
  no_min: number;
  /** Has a minimum but no quantity at all: in none of the four stats. */
  unknown_qty_with_min: number;
  /** Empty bins that carry no minimum, so nothing can flag them. */
  zero_qty_no_min: number;
  no_unit: number;
}

/**
 * A stock_min of 0 is treated as "no minimum", not as a minimum of zero. That is
 * what makes the four buckets a partition: read literally, an item with
 * stock_min = 0 and quantity = 0 satisfies "out of stock" AND the degenerate
 * [0, 0] "approaching" band AND "no minimum set" at once, and 25 live rows do
 * exactly that. A minimum of zero can never fire a reorder anyway, which is the
 * same reason a NULL cannot.
 *
 * quantity and stock_min are numeric(12,2), and TypeORM returns numeric as a
 * STRING — so every comparison stays in SQL. In JS '9' < '10' is false.
 */
const STOCK_COUNTS_SQL = `
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE min_set)::int AS with_min,
    COUNT(*) FILTER (WHERE min_set AND qty IS NOT NULL AND qty <= 0)::int
      AS out_of_stock,
    COUNT(*) FILTER (WHERE min_set AND qty > 0 AND qty < min_qty)::int
      AS below_min,
    COUNT(*) FILTER (
      WHERE min_set AND qty >= min_qty AND qty <= min_qty * $2::numeric
    )::int AS approaching_min,
    COUNT(*) FILTER (WHERE NOT min_set)::int AS no_min,
    COUNT(*) FILTER (WHERE min_set AND qty IS NULL)::int AS unknown_qty_with_min,
    COUNT(*) FILTER (WHERE NOT min_set AND qty IS NOT NULL AND qty <= 0)::int
      AS zero_qty_no_min,
    COUNT(*) FILTER (WHERE unit IS NULL)::int AS no_unit
  FROM (
    SELECT
      quantity::numeric AS qty,
      stock_min::numeric AS min_qty,
      (stock_min IS NOT NULL AND stock_min::numeric > 0) AS min_set,
      unit
    FROM inventory_items
    WHERE ship_id = $1
  ) i
`;

/**
 * Inventory tile of the admin Overview: spare parts running low.
 *
 * On the live vessel only a fifth of the register carries a usable minimum, so
 * the honest finding on this tile is usually "no minimum set" rather than any
 * shortage — the notes say so with the actual figures rather than letting three
 * small red numbers imply the stockroom is under control.
 */
@Injectable()
export class InventoryAggregator {
  private readonly logger = new Logger(InventoryAggregator.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async collect(shipId: string): Promise<OverviewCard> {
    let row: StockCounts;
    try {
      const rows: StockCounts[] = await this.dataSource.query(STOCK_COUNTS_SQL, [
        shipId,
        APPROACHING_BAND,
      ]);
      if (!rows.length) throw new Error('aggregate returned no row');
      row = rows[0];
    } catch (error) {
      this.logger.error(
        `inventory overview aggregate failed for ship ${shipId}: ${formatError(error)}`,
      );
      return {
        key: 'inventory',
        title: 'Inventory',
        headline: null,
        headlineLabel: 'items tracked',
        stats: [],
        notes: ['Stock levels could not be read from the database.'],
        section: 'inventory',
        degraded: {
          reason: 'The inventory stock aggregate could not be read.',
          affects: [
            'items tracked',
            'out of stock',
            'below minimum',
            'approaching minimum',
            'no minimum set',
          ],
        },
      };
    }

    if (row.total === 0) {
      return {
        key: 'inventory',
        title: 'Inventory',
        headline: null,
        headlineLabel: 'items tracked',
        stats: [],
        notes: ['No stock items have been imported for this vessel yet.'],
        section: 'inventory',
      };
    }

    const bandPercent = Math.round((APPROACHING_BAND - 1) * 100);
    const minPercent = Math.round((row.with_min / row.total) * 100);

    const notes = [
      `'Approaching minimum' means within ${bandPercent}% above stock_min. That band is this page's convention, not a reorder point the system knows: nothing in the schema holds a lead time, a consumption rate or any stock movement history, so quantity is a single current figure and no number here says how fast a part is being used up.`,
      `Only ${row.with_min} of the ${row.total} items carry a usable minimum (stock_min above zero), so the three shortage counts look at ${minPercent}% of the register — everything else sits in 'no minimum set' and cannot be flagged at all.`,
      'The four counts do not overlap. Items comfortably above their minimum are not shown.',
    ];

    if (row.zero_qty_no_min > 0) {
      notes.push(
        `${row.zero_qty_no_min} ${row.zero_qty_no_min === 1 ? 'item is' : 'items are'} at zero quantity with no minimum configured — empty bins that no low-stock check can reach. They are counted under 'no minimum set', not 'out of stock'.`,
      );
    }
    if (row.unknown_qty_with_min > 0) {
      notes.push(
        `${row.unknown_qty_with_min} ${row.unknown_qty_with_min === 1 ? 'item has' : 'items have'} a minimum but no quantity recorded at all, so ${row.unknown_qty_with_min === 1 ? 'it falls' : 'they fall'} into none of the four counts. A blank quantity is not read as zero.`,
      );
    }
    // Worth surfacing because it undercuts the reason a proportional band was
    // chosen over a flat one: "5 below minimum" cannot be read as litres,
    // metres or pieces when the unit is simply absent.
    if (row.no_unit > row.total / 2) {
      notes.push(
        `${row.no_unit} of ${row.total} items record no unit of measure, so the quantities behind these counts are bare numbers.`,
      );
    }

    return {
      key: 'inventory',
      title: 'Inventory',
      headline: row.total,
      headlineLabel: 'items tracked',
      stats: [
        {
          label: 'out of stock',
          value: row.out_of_stock,
          tone: this.tone(row.out_of_stock > 0, 'bad'),
          hint: 'Quantity at or below zero, among items that have a minimum above zero. Excludes empty bins with no minimum set, and items whose quantity was never recorded.',
        },
        {
          label: 'below minimum',
          value: row.below_min,
          tone: this.tone(row.below_min > 0, 'bad'),
          hint: 'Some stock left but under stock_min. Excludes items already at zero, which are counted as out of stock.',
        },
        {
          label: 'approaching minimum',
          value: row.approaching_min,
          tone: this.tone(row.approaching_min > 0, 'warn'),
          hint: `At the minimum or up to ${bandPercent}% above it. A convention of this page, not a configured reorder point — it ignores lead time and how fast the part is consumed.`,
        },
        {
          label: 'no minimum set',
          value: row.no_min,
          tone: this.tone(row.no_min > 0, 'warn'),
          hint: 'stock_min is empty or zero, so the item can never trigger a reorder and is invisible to the three counts above — however low it actually is.',
        },
      ],
      notes,
      section: 'inventory',
    };
  }

  private tone(flagged: boolean, whenFlagged: OverviewStatTone): OverviewStatTone {
    return flagged ? whenFlagged : 'neutral';
  }
}
