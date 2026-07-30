import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { formatError } from '../../../common/utils/error.utils';
import { OverviewCard } from '../overview.types';

/**
 * Row shape of the single aggregate below. Every count is cast to int4 in SQL
 * because pg returns bigint (COUNT) as a string.
 */
interface AssetLinkCounts {
  total: number;
  with_metric: number;
  with_task: number;
  /** Task links counted without the source exclusions — feeds the caveat note. */
  with_task_any: number;
  with_manual: number;
  /** Document links counted including 'excluded' — feeds the caveat note. */
  with_manual_any: number;
  with_certificate: number;
  unlinked: number;
}

/**
 * None of the four link tables carries ship_id, so each leg is an EXISTS
 * correlated to `assets`, which is the only ship-scoped table in play. Doing it
 * as EXISTS rather than four LEFT JOINs also keeps the row count at one per
 * asset — joining would multiply assets by their links (972 import-history task
 * links across 79 assets on the live vessel) and break the FILTER counts.
 */
const LINK_COUNTS_SQL = `
  SELECT
    COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE has_metric)::int AS with_metric,
    COUNT(*) FILTER (WHERE has_task)::int AS with_task,
    COUNT(*) FILTER (WHERE has_task_any)::int AS with_task_any,
    COUNT(*) FILTER (WHERE has_manual)::int AS with_manual,
    COUNT(*) FILTER (WHERE has_manual_any)::int AS with_manual_any,
    COUNT(*) FILTER (WHERE has_certificate)::int AS with_certificate,
    -- Deliberately the WIDE legs: an asset whose only task link is imported
    -- history, or whose only document link is a suppression, is still an asset
    -- somebody has touched. Counting it as untouched would send an admin to
    -- enrich a row that already has data, and the number would exceed what
    -- every other section reports as linked.
    COUNT(*) FILTER (
      WHERE NOT (has_metric OR has_task_any OR has_manual_any OR has_certificate)
    )::int AS unlinked
  FROM (
    SELECT
      EXISTS (
        SELECT 1 FROM ship_metric_catalog smc
        WHERE smc.bound_asset_id = a.id
      ) AS has_metric,
      EXISTS (
        SELECT 1
        FROM pms_task_assets pta
        JOIN pms_tasks t ON t.id = pta.task_id
        WHERE pta.asset_id = a.id
          AND t.source NOT IN ('import-history', 'alert')
      ) AS has_task,
      EXISTS (
        SELECT 1 FROM pms_task_assets pta WHERE pta.asset_id = a.id
      ) AS has_task_any,
      EXISTS (
        SELECT 1
        FROM asset_documents ad
        WHERE ad.asset_id = a.id
          AND ad.link_type <> 'excluded'
      ) AS has_manual,
      EXISTS (
        SELECT 1 FROM asset_documents ad WHERE ad.asset_id = a.id
      ) AS has_manual_any,
      -- doc_asset_links rows point at either an asset or a crew member;
      -- matching on asset_id is what keeps the PERSONNEL ones out.
      EXISTS (
        SELECT 1 FROM doc_asset_links dal WHERE dal.asset_id = a.id
      ) AS has_certificate
    FROM assets a
    WHERE a.ship_id = $1
  ) links
`;

@Injectable()
export class AssetsOverviewAggregator {
  private readonly logger = new Logger(AssetsOverviewAggregator.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async collect(shipId: string): Promise<OverviewCard> {
    let row: AssetLinkCounts;
    try {
      const rows: AssetLinkCounts[] = await this.dataSource.query(
        LINK_COUNTS_SQL,
        [shipId],
      );
      if (!rows.length) throw new Error('aggregate returned no row');
      row = rows[0];
    } catch (error) {
      this.logger.error(
        `asset overview aggregate failed for ship ${shipId}: ${formatError(error)}`,
      );
      return {
        key: 'assets',
        title: 'Asset register',
        headline: null,
        headlineLabel: 'assets',
        stats: [],
        notes: ['Asset register counts could not be read from the database.'],
        section: 'assets',
        degraded: {
          reason: 'The asset link aggregate could not be read.',
          affects: [
            'assets',
            'with a bound metric',
            'with a PMS task',
            'with a manual or drawing',
            'with a certificate',
            'nothing linked',
          ],
        },
      };
    }

    if (row.total === 0) {
      return {
        key: 'assets',
        title: 'Asset register',
        headline: null,
        headlineLabel: 'assets',
        stats: [],
        notes: ['No assets have been imported for this vessel yet.'],
        section: 'assets',
      };
    }

    const notes = [
      'An asset can hold several kinds of link, so the five counts overlap and do not add up to the total.',
    ];

    // Both deltas exist to reconcile this tile against the PMS and Documents
    // sections, which count the raw link rows and therefore report more assets.
    const historyOnly = row.with_task_any - row.with_task;
    if (historyOnly > 0) {
      notes.push(
        `${historyOnly} further asset${historyOnly === 1 ? ' is' : 's are'} referenced only by imported completion history or alert-spawned tasks; those are records of work done, not a maintenance schedule, so they do not count as a PMS link.`,
      );
    }

    const excludedOnly = row.with_manual_any - row.with_manual;
    if (excludedOnly > 0) {
      notes.push(
        `${excludedOnly} asset${excludedOnly === 1 ? '' : 's'} only ${excludedOnly === 1 ? 'has' : 'have'} suppressed ('excluded') document links, which count as no manual.`,
      );
    }

    notes.push(
      'Nothing linked counts an asset as touched if it carries any link at all, imported history and suppressed documents included — so it is never larger than the gap the other sections would show.',
    );

    return {
      key: 'assets',
      title: 'Asset register',
      headline: row.total,
      headlineLabel: 'assets',
      stats: [
        {
          label: 'with a bound metric',
          value: row.with_metric,
          tone: 'neutral',
          hint: 'Assets bound to at least one catalog metric, disabled entries included. Metrics that arrive from Influx but were never bound to an asset are not counted.',
        },
        {
          label: 'with a PMS task',
          value: row.with_task,
          tone: 'neutral',
          hint: "Both boards. Excludes imported completion-history rows and alert-spawned tasks, so it is lower than the PMS section's own asset count.",
        },
        {
          label: 'with a manual or drawing',
          value: row.with_manual,
          tone: 'neutral',
          hint: "Curated document links only, 'excluded' suppressions aside. Brand/model matches that chat discovers on the fly are not stored as links and are not counted.",
        },
        {
          label: 'with a certificate',
          value: row.with_certificate,
          tone: 'neutral',
          hint: 'Compliance-document links pointing at this asset. Links pointing at a crew member instead belong to no asset and are not counted.',
        },
        {
          label: 'nothing linked',
          value: row.unlinked,
          tone: 'warn',
          hint: "None of the four link kinds. Says nothing about the asset's own fields — serial, location and hours may all be filled in.",
        },
      ],
      notes,
      section: 'assets',
    };
  }
}
