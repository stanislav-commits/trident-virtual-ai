import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { formatError } from '../../../common/utils/error.utils';
import type { OverviewCard, OverviewStat } from '../overview.types';

/**
 * Alerts tile. The `alerts` table is four different things wearing one shape,
 * so a naive COUNT(*) over firing rows is a lie: `metric` rows are Grafana
 * telemetry alarms (real equipment faults), `certificate` rows are compliance
 * expiry reminders written by the 06:00 cron, `trend` rows are statistical
 * deviation notices, and `daily_brief` rows are the morning-brief notification.
 * On SeaWolfX today 41 of the 81 firing rows are certificate reminders — an
 * admin who reads that as "41 alarms" goes looking in the engine room for a
 * problem that lives in the document register.
 *
 * So the headline counts firing `metric` rows only, every other kind gets its
 * own row or a note, and Grafana's datasource-health rules are held out of the
 * fault numbers because "telemetry stopped arriving" is not a machinery fault.
 */
@Injectable()
export class AlertsAggregator {
  private readonly logger = new Logger(AlertsAggregator.name);

  /**
   * Grafana emits these two under the rule's own name when a query fails or
   * returns nothing. They are pipeline health, not vessel health.
   */
  private static readonly HEALTH_RULES = ['DatasourceNoData', 'DatasourceError'];

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async collect(shipId: string): Promise<OverviewCard> {
    try {
      const rows: AlertsRow[] = await this.dataSource.query(SQL, [
        shipId,
        AlertsAggregator.HEALTH_RULES,
      ]);
      return this.toCard(rows[0]);
    } catch (error) {
      this.logger.warn(
        `Alerts overview failed for ship ${shipId}: ${formatError(error)}`,
      );
      return {
        key: 'alerts',
        title: 'Alerts',
        headline: null,
        headlineLabel: 'firing equipment alarms',
        stats: [],
        notes: [
          'The alerts table could not be read, so nothing on this tile is a count of anything. Treat it as unknown, not as zero.',
        ],
        section: 'alerts',
        degraded: {
          reason: 'The alerts aggregate could not be read.',
          affects: [
            'Critical',
            'Warning',
            'Unacknowledged',
            'Certificate reminders',
            'Seen in last 24h',
          ],
        },
      };
    }
  }

  private toCard(row: AlertsRow | undefined): OverviewCard {
    const totalRows = num(row?.total_rows);
    const firing = num(row?.metric_firing);
    const critical = num(row?.metric_firing_critical);
    const warning = num(row?.metric_firing_warning);
    const otherSeverity = num(row?.metric_firing_other_severity);
    const unacked = num(row?.metric_firing_unacked);
    const seen24h = num(row?.metric_seen_24h);
    const certFiring = num(row?.cert_firing);
    const trendFiring = num(row?.trend_firing);
    const briefFiring = num(row?.brief_firing);
    const datasourceFiring = num(row?.datasource_firing);
    const unassigned = num(row?.unassigned_rows);
    const timeIndexes = num(row?.time_scoped_indexes);
    const shipIndexes = num(row?.ship_scoped_indexes);
    const historyDays = daysSince(row?.oldest_started_at);

    const stats: OverviewStat[] = [
      {
        label: 'Critical',
        value: critical,
        tone: critical > 0 ? 'bad' : 'good',
        hint: 'Firing metric alarms with severity critical. Excludes certificate reminders, trend warnings, brief entries and Grafana datasource-health rules.',
      },
      {
        label: 'Warning',
        value: warning,
        tone: warning > 0 ? 'warn' : 'good',
        hint: 'Firing metric alarms with severity warning — this bucket also absorbs every alarm that arrived with no severity label at all, so it reads high.',
      },
      {
        label: 'Unacknowledged',
        value: unacked,
        tone: unacked > 0 ? 'warn' : 'good',
        hint: 'Firing metric alarms with no acked_at timestamp. Does not include acknowledged alarms that are still firing — acknowledging is not fixing.',
      },
      {
        label: 'Certificate reminders',
        value: certFiring,
        tone: certFiring > 0 ? 'warn' : 'neutral',
        hint: 'Firing compliance-expiry reminders, NOT equipment faults: the 06:00 cron writes one per expiring or expired certificate. Fix these in Compliance.',
      },
      {
        label: 'Seen in last 24h',
        value: seen24h,
        tone: 'neutral',
        hint: 'Metric alarms whose last_seen_at falls in the last 24h, firing OR already resolved — an activity count, not an open-fault count.',
      },
    ];

    const notes: string[] = [];

    if (totalRows === 0) {
      notes.push(
        'No alert has ever been recorded for this vessel. That is not the same as "nothing is wrong" — an unconfigured Grafana webhook looks identical, so check that alarms are actually reaching /api/alerts/grafana.',
      );
    }

    notes.push(
      'Severity arrives from Grafana as critical / warning / info. An alarm with a MISSING severity label silently becomes "warning" (normSeverity in alerts.service.ts), so the warning row counts unlabelled rules too and no row is a faithful picture of real urgency.',
    );
    notes.push(
      'There is no "acknowledged" status — only an acked_at timestamp. An acknowledged alarm keeps status "firing" and stays in the headline; the Unacknowledged row is the only place acking shows up.',
    );
    notes.push(
      `Grafana's own datasource-health rules (${AlertsAggregator.HEALTH_RULES.join(
        ', ',
      )}) are excluded from every metric number here — they mean telemetry stopped arriving, not that equipment failed.` +
        (datasourceFiring > 0
          ? ` ${datasourceFiring} of them ${datasourceFiring === 1 ? 'is' : 'are'} firing right now, so the alarm counts may be understated: a rule that cannot query Influx cannot fire.`
          : ''),
    );

    if (otherSeverity > 0) {
      notes.push(
        `${otherSeverity} firing metric alarm(s) carry a severity that is neither critical nor warning (info, or "high" from an error/major label), so the two severity rows do not add up to the headline.`,
      );
    }
    if (trendFiring > 0 || briefFiring > 0) {
      notes.push(
        `Also live in this table and excluded from every number above: ${trendFiring} trend warning(s) (statistical deviation from the AI-derived typical range, not a threshold breach) and ${briefFiring} morning-brief notification(s).`,
      );
    }
    if (unassigned > 0) {
      notes.push(
        `${unassigned} alert row(s) have ship_id NULL — the webhook could not resolve a vessel — and therefore appear on no vessel's Overview at all.`,
      );
    }
    if (totalRows > 0 && historyDays !== null) {
      const perDay = Math.round(totalRows / Math.max(historyDays, 1));
      notes.push(
        `No retention policy: ${totalRows} rows accumulated in ${historyDays} day(s) (~${perDay}/day) and nothing prunes them. Every Grafana re-fire episode is kept forever.`,
      );
    }
    if (timeIndexes === 0) {
      notes.push(
        `There is no index on started_at or last_seen_at, so the 24h count and the alert history list scan the whole table${
          shipIndexes > 0
            ? ' (ship_id-scoped lookups are indexed)'
            : ' and ship_id is not indexed either'
        }. Fine at today's row count, not fine for long — add one deliberately.`,
      );
    }

    return {
      key: 'alerts',
      title: 'Alerts',
      headline: totalRows === 0 ? null : firing,
      headlineLabel: 'firing equipment alarms',
      stats,
      notes,
      section: 'alerts',
    };
  }
}

type AlertsRow = {
  total_rows: number | string;
  oldest_started_at: Date | string | null;
  metric_firing: number | string;
  metric_firing_critical: number | string;
  metric_firing_warning: number | string;
  metric_firing_other_severity: number | string;
  metric_firing_unacked: number | string;
  metric_seen_24h: number | string;
  cert_firing: number | string;
  trend_firing: number | string;
  brief_firing: number | string;
  datasource_firing: number | string;
  unassigned_rows: number | string;
  ship_scoped_indexes: number | string;
  time_scoped_indexes: number | string;
};

/**
 * One pass over the ship's alerts, split by source in FILTER clauses. The two
 * pg_indexes subqueries are here rather than in a second round-trip so the tile
 * can tell the admin that its own history numbers are unindexed — a caveat
 * about the number belongs with the number.
 */
const SQL = `
  SELECT
    COUNT(*)::int AS total_rows,
    MIN(started_at) AS oldest_started_at,
    COUNT(*) FILTER (
      WHERE source = 'metric' AND status = 'firing' AND rule_name <> ALL ($2)
    )::int AS metric_firing,
    COUNT(*) FILTER (
      WHERE source = 'metric' AND status = 'firing' AND rule_name <> ALL ($2)
        AND severity = 'critical'
    )::int AS metric_firing_critical,
    COUNT(*) FILTER (
      WHERE source = 'metric' AND status = 'firing' AND rule_name <> ALL ($2)
        AND severity = 'warning'
    )::int AS metric_firing_warning,
    COUNT(*) FILTER (
      WHERE source = 'metric' AND status = 'firing' AND rule_name <> ALL ($2)
        AND severity NOT IN ('critical', 'warning')
    )::int AS metric_firing_other_severity,
    COUNT(*) FILTER (
      WHERE source = 'metric' AND status = 'firing' AND rule_name <> ALL ($2)
        AND acked_at IS NULL
    )::int AS metric_firing_unacked,
    COUNT(*) FILTER (
      WHERE source = 'metric' AND rule_name <> ALL ($2)
        AND last_seen_at >= NOW() - INTERVAL '24 hours'
    )::int AS metric_seen_24h,
    COUNT(*) FILTER (WHERE source = 'certificate' AND status = 'firing')::int AS cert_firing,
    COUNT(*) FILTER (WHERE source = 'trend' AND status = 'firing')::int AS trend_firing,
    COUNT(*) FILTER (WHERE source = 'daily_brief' AND status = 'firing')::int AS brief_firing,
    COUNT(*) FILTER (
      WHERE source = 'metric' AND status = 'firing' AND rule_name = ANY ($2)
    )::int AS datasource_firing,
    (SELECT COUNT(*) FROM alerts WHERE ship_id IS NULL)::int AS unassigned_rows,
    (SELECT COUNT(*) FROM pg_indexes
      WHERE tablename = 'alerts' AND schemaname = current_schema()
        AND indexdef ~ 'ship_id')::int AS ship_scoped_indexes,
    (SELECT COUNT(*) FROM pg_indexes
      WHERE tablename = 'alerts' AND schemaname = current_schema()
        AND indexdef ~ '(started_at|last_seen_at)')::int AS time_scoped_indexes
  FROM alerts
  WHERE ship_id = $1
`;

function num(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

function daysSince(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const then = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(then.getTime())) return null;
  return Math.max(1, Math.round((Date.now() - then.getTime()) / 86_400_000));
}
