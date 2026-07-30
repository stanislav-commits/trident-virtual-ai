import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { formatError } from '../../../common/utils/error.utils';
import type { OverviewCard, OverviewStat } from '../overview.types';

/**
 * Metrics-catalog tile.
 *
 * The catalog is a list of Influx keys plus the AI metadata hung off each one —
 * it is NOT telemetry. Nothing in Postgres records when a metric last produced a
 * data point, so the one question an admin actually wants answered here ("is
 * this sensor still reporting?") cannot be answered by this tile at any price;
 * it needs an Influx read, which the Overview deliberately never does. Every
 * number below is therefore about the *description* of the fleet's telemetry,
 * and the notes exist to stop it being read as the telemetry itself.
 *
 * `ai_warnings` is not used as a fault signal even though it looks like one:
 * `persistAnalysis` writes it (as a JSON array, `[]` included) on every row it
 * touches, so on production all 1881 analysed rows carry the column and a
 * "metrics with warnings" count would just be the analysed count again.
 */

/** Every count is cast to int4 because pg hands COUNT() back as a bigint string. */
interface MetricCatalogCounts {
  total: number;
  enabled: number;
  disabled: number;
  analysed: number;
  not_analysed: number;
  bound: number;
  unbound: number;
  manual_scale: number;
  /**
   * Whole calendar days between the last sync and today, which is what "19 days
   * ago" means to a person; a time-of-day subtraction would report 18 for a sync
   * made 18 days and 22 hours back. NULL only when the catalog is empty.
   */
  catalog_age_days: number | null;
}

/**
 * One pass over the ship's catalog rows. A sync stamps the same `synced_at` on
 * every surviving row, so MAX() is the timestamp of the last successful sync of
 * the whole catalog rather than any per-metric freshness.
 */
const CATALOG_COUNTS_SQL = `
  SELECT
    COUNT(*)::int                                             AS total,
    COUNT(*) FILTER (WHERE is_enabled)::int                   AS enabled,
    COUNT(*) FILTER (WHERE NOT is_enabled)::int               AS disabled,
    COUNT(*) FILTER (WHERE ai_generated_at IS NOT NULL)::int  AS analysed,
    COUNT(*) FILTER (WHERE ai_generated_at IS NULL)::int      AS not_analysed,
    COUNT(*) FILTER (WHERE bound_asset_id IS NOT NULL)::int   AS bound,
    COUNT(*) FILTER (WHERE bound_asset_id IS NULL)::int       AS unbound,
    COUNT(*) FILTER (WHERE scale_source = 'manual')::int      AS manual_scale,
    (CURRENT_DATE - MAX(synced_at)::date)::int                AS catalog_age_days
  FROM ship_metric_catalog
  WHERE ship_id = $1
`;

/** Above this the catalog has almost certainly drifted from what Influx holds. */
const STALE_AFTER_DAYS = 7;

@Injectable()
export class MetricsOverviewAggregator {
  private readonly logger = new Logger(MetricsOverviewAggregator.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async collect(shipId: string): Promise<OverviewCard> {
    let row: MetricCatalogCounts;
    try {
      const rows: MetricCatalogCounts[] = await this.dataSource.query(
        CATALOG_COUNTS_SQL,
        [shipId],
      );
      if (!rows.length) throw new Error('aggregate returned no row');
      row = rows[0];
    } catch (error) {
      this.logger.warn(
        `Metrics catalog overview failed for ship ${shipId}: ${formatError(error)}`,
      );
      return {
        key: 'metrics',
        title: 'Metrics catalog',
        headline: null,
        headlineLabel: 'catalog metrics',
        stats: [],
        notes: [
          'The metrics catalog could not be read, so nothing on this tile is a count of anything. Treat it as unknown, not as an empty catalog.',
        ],
        section: 'metrics',
        degraded: {
          reason: 'The metric catalog aggregate could not be read.',
          affects: [
            'catalog metrics',
            'Enabled',
            'Analysed by AI',
            'Not analysed',
            'Bound to an asset',
            'Not bound to an asset',
            'Scale locked by hand',
            'Catalog last synced (days ago)',
          ],
        },
      };
    }

    const total = Number(row.total);
    const notes = this.baseNotes();

    if (total === 0) {
      return {
        key: 'metrics',
        title: 'Metrics catalog',
        headline: null,
        headlineLabel: 'catalog metrics',
        stats: [],
        notes: [
          'No metrics have been synced for this vessel yet. Either the vessel has no Influx organization configured or the catalog has never been synced, so chat cannot answer a single telemetry question about it.',
          ...notes,
        ],
        section: 'metrics',
      };
    }

    const notAnalysed = Number(row.not_analysed);
    const unbound = Number(row.unbound);
    const disabled = Number(row.disabled);
    const ageDays = row.catalog_age_days === null ? null : Number(row.catalog_age_days);

    const stats: OverviewStat[] = [
      {
        label: 'Enabled',
        value: Number(row.enabled),
        tone: 'neutral',
        hint: 'Rows with is_enabled set. The flag only hides a metric from the admin list filter, the sibling picker and the running-hours asset binding — it does not hide it from chat, so this is not a count of what the AI can reach.',
      },
      {
        label: 'Analysed by AI',
        value: Number(row.analysed),
        tone: 'neutral',
        hint: 'Rows carrying an ai_generated_at stamp. Says only that an analysis ran — not that its unit, kind or asset binding is correct, and not that the metric has produced data since.',
      },
      {
        label: 'Not analysed',
        value: notAnalysed,
        tone: notAnalysed > 0 ? 'warn' : 'neutral',
        hint: 'No AI description, unit or typical band, so chat has nothing but the raw Influx key to go on and the trend scanner skips these entirely. Does not mean the metric is broken.',
      },
      {
        label: 'Bound to an asset',
        value: Number(row.bound),
        tone: 'neutral',
        hint: 'bound_asset_id is set, by AI or by an admin — the two are not distinguished here. Counts bindings to disabled catalog entries too.',
      },
      {
        label: 'Not bound to an asset',
        value: unbound,
        tone: unbound > 0 ? 'warn' : 'neutral',
        hint: 'Readable by key but attached to no equipment, so it never appears on an asset, never feeds running hours and never raises a trend warning. Many of these are vessel-wide readings that legitimately belong to no single asset.',
      },
      {
        label: 'Scale locked by hand',
        value: Number(row.manual_scale),
        tone: 'neutral',
        hint: "Rows with scale_source 'manual': an admin corrected the magnitude and the auto-profiler must leave it alone. A low number is normal, not a gap.",
      },
    ];

    if (ageDays === null) {
      notes.push(
        'The last catalog sync date could not be read, so the staleness of these numbers is unknown.',
      );
    } else {
      stats.push({
        label: 'Catalog last synced (days ago)',
        value: ageDays,
        tone: ageDays > STALE_AFTER_DAYS ? 'bad' : 'neutral',
        hint: 'Whole calendar days since the key list was last reconciled with Influx. Measures the age of the LIST, not of the data: new sensors added since are missing from every count above, and keys that stopped reporting are still counted.',
      });
    }

    if (disabled > 0) {
      notes.push(
        `${disabled} catalog ${disabled === 1 ? 'row is' : 'rows are'} disabled but still counted in the total and in every other number here.`,
      );
    }

    return {
      key: 'metrics',
      title: 'Metrics catalog',
      headline: total,
      headlineLabel: 'catalog metrics',
      stats,
      notes,
      section: 'metrics',
    };
  }

  private baseNotes(): string[] {
    return [
      'Postgres holds no data-freshness signal at all: no column records when a metric last produced a value. So "is this metric still working" cannot be answered on this page — it needs a read against Influx, which the Overview never performs.',
      'Re-syncing the catalog DELETES every row whose key has vanished from Influx discovery, and the row takes its AI analysis, its asset binding and its manual scale lock with it. A sync run against a partial or misconfigured discovery therefore destroys hand-curated metadata that cannot be recovered — the staleness figure above is a fact to weigh, not a button to press.',
      'Re-analysing a metric overwrites bound_asset_id with whatever the AI proposes, so an admin-made binding survives only until the next analyze; the bound and unbound counts mix both origins.',
    ];
  }
}
