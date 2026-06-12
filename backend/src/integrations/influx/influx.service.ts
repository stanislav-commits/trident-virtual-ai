import { Injectable } from '@nestjs/common';
import { InfluxDB } from '@influxdata/influxdb-client';
import { ConfigService } from '@nestjs/config';
import { IntegrationStatusDto } from '../../common/dto/integration-status.dto';
import { InfluxHttpService } from './influx-http.service';

interface InfluxOrganizationsResponse {
  orgs?: Array<{ name?: string | null }>;
}

interface InfluxBucketsResponse {
  buckets?: Array<{ name?: string | null }>;
}

export interface InfluxMetricDefinition {
  key: string;
  bucket: string;
  measurement: string;
  field: string;
  label: string;
}

export interface InfluxMetricSelector {
  bucket: string;
  measurement: string;
  field: string;
}

export interface InfluxMetricSample extends InfluxMetricSelector {
  timestamp: string;
  value: string | number | boolean | null;
}

@Injectable()
export class InfluxService {
  private influxClient: InfluxDB | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly influxHttpService: InfluxHttpService,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.configService.get<string>('integrations.influx.url') &&
        this.configService.get<string>('integrations.influx.token'),
    );
  }

  async listOrganizations(): Promise<string[]> {
    const url = this.configService.get<string>('integrations.influx.url', '');
    const token = this.configService.get<string>('integrations.influx.token', '');

    if (!url || !token) {
      return [];
    }

    const response = await this.influxHttpService.requestJson<InfluxOrganizationsResponse>(
      '/api/v2/orgs',
      token,
      { limit: '100' },
    );

    return [
      ...new Set(
        (response.orgs ?? [])
          .map((orgItem) => orgItem.name?.trim() ?? '')
          .filter(Boolean),
      ),
      ].sort((left, right) => left.localeCompare(right));
  }

  async listBuckets(orgName: string): Promise<string[]> {
    const normalizedOrgName = orgName.trim();

    if (!normalizedOrgName) {
      return [];
    }

    const token = this.configService.get<string>('integrations.influx.token', '');
    if (!token) {
      return [];
    }

    const response = await this.influxHttpService.requestJson<InfluxBucketsResponse>(
      '/api/v2/buckets',
      token,
      {
        org: normalizedOrgName,
        limit: '100',
      },
    );

    return [
      ...new Set(
        (response.buckets ?? [])
          .map((bucket) => bucket.name?.trim() ?? '')
          .filter((bucket) => bucket && !bucket.startsWith('_')),
      ),
    ].sort((left, right) => left.localeCompare(right));
  }

  async listAllMetrics(orgName: string): Promise<InfluxMetricDefinition[]> {
    const normalizedOrgName = orgName.trim();

    if (!normalizedOrgName) {
      return [];
    }

    const buckets = await this.listBuckets(normalizedOrgName);
    const metrics: InfluxMetricDefinition[] = [];

    for (const bucket of buckets) {
      const measurements = await this.listMeasurements(normalizedOrgName, bucket);

      for (const measurement of measurements) {
        const fields = await this.listFieldKeys(
          normalizedOrgName,
          bucket,
          measurement,
        );

        for (const field of fields) {
          metrics.push({
            key: `${bucket}::${measurement}::${field}`,
            bucket,
            measurement,
            field,
            label: `${measurement}.${field}`,
          });
        }
      }
    }

    return metrics;
  }

  async queryLatestMetric(
    orgName: string,
    metric: InfluxMetricSelector,
  ): Promise<InfluxMetricSample | null> {
    return this.queryMetricSample(orgName, metric, {
      start: this.getQueryLookback(),
    });
  }

  async queryMetricAtTime(
    orgName: string,
    metric: InfluxMetricSelector,
    timestamp: Date,
  ): Promise<InfluxMetricSample | null> {
    return this.queryMetricSample(orgName, metric, {
      start: this.getQueryLookback(),
      stop: this.toFluxAbsoluteTime(timestamp),
    });
  }

  /**
   * Aggregate a single metric over [start, end] with the chosen reducer.
   * Returns one sample per metric (value = aggregated number, timestamp =
   * the representative time the reducer emits, falling back to `end`).
   *
   * Reducers:
   *   mean / sum / last / first / min / max — direct Flux single-fn reducers.
   *   delta    → reduce-fold yielding (last − first); correct for cumulative
   *              counters ("how much was added during the window?").
   *   integral → Flux `integral(unit: 1h)`; for rate metrics this yields the
   *              total over the window in the rate's numerator unit (L/h ⇒ L,
   *              W ⇒ Wh which the caller can divide by 1000 for kWh).
   *
   * For mean/sum Flux doesn't emit `_time`, so the sample timestamp falls
   * back to the window end.
   */
  async queryMetricRange(
    orgName: string,
    metric: InfluxMetricSelector,
    start: Date,
    end: Date,
    aggregation:
      | 'mean'
      | 'sum'
      | 'last'
      | 'first'
      | 'min'
      | 'max'
      | 'delta'
      | 'integral' = 'mean',
  ): Promise<InfluxMetricSample | null> {
    const prefix = [
      `from(bucket: ${this.toFluxString(metric.bucket)})`,
      `|> range(start: ${this.toFluxAbsoluteTime(start)}, stop: ${this.toFluxAbsoluteTime(end)})`,
      `|> filter(fn: (r) => r._measurement == ${this.toFluxString(metric.measurement)} and r._field == ${this.toFluxString(metric.field)})`,
      '|> group()',
    ];

    let flux: string;
    if (aggregation === 'delta') {
      // Capture first and last value across the (now ungrouped) stream and
      // emit a single row with the delta. Works correctly for monotonic
      // cumulative counters; for non-monotonic gauges the semantic is
      // "value at end − value at start" which is what the caller asked for.
      flux = [
        ...prefix,
        '|> sort(columns: ["_time"])',
        '|> reduce(',
        '    fn: (r, accumulator) => ({',
        '      first: if accumulator.n == 0 then r._value else accumulator.first,',
        '      last: r._value,',
        '      n: accumulator.n + 1,',
        '    }),',
        '    identity: {first: 0.0, last: 0.0, n: 0}',
        '  )',
        '|> map(fn: (r) => ({_value: r.last - r.first}))',
      ].join('\n');
    } else if (aggregation === 'integral') {
      // ∫ rate dt. unit: 1h matches the common rate units in vessel
      // telemetry (L/h, W, etc.). Result column is in (value_unit × hour).
      flux = [...prefix, '|> integral(unit: 1h, column: "_value")'].join('\n');
    } else {
      flux = [...prefix, `|> ${aggregation}()`].join('\n');
    }

    const rows = await this.queryRows(flux, orgName);
    const row = rows[0];

    if (!row) {
      return null;
    }

    return {
      bucket: metric.bucket,
      measurement: metric.measurement,
      field: metric.field,
      timestamp: this.toText(row._time) ?? end.toISOString(),
      value: this.normalizeSampleValue(row._value),
    };
  }

  /**
   * Returns down-sampled time/value pairs over [start, end] using
   * `aggregateWindow`. Used by MetricUnderstandingService for the 7-day
   * fingerprint that backs each metric's AI analysis bundle.
   */
  async queryMetricSamples(
    orgName: string,
    metric: InfluxMetricSelector,
    start: Date,
    end: Date,
    everyDuration: string = '5m',
  ): Promise<Array<{ timestamp: string; value: number }>> {
    const flux = [
      `from(bucket: ${this.toFluxString(metric.bucket)})`,
      `|> range(start: ${this.toFluxAbsoluteTime(start)}, stop: ${this.toFluxAbsoluteTime(end)})`,
      `|> filter(fn: (r) => r._measurement == ${this.toFluxString(metric.measurement)} and r._field == ${this.toFluxString(metric.field)})`,
      `|> aggregateWindow(every: ${everyDuration}, fn: mean, createEmpty: false)`,
      '|> keep(columns: ["_time", "_value"])',
    ].join('\n');

    const rows = await this.queryRows(flux, orgName);
    const out: Array<{ timestamp: string; value: number }> = [];
    for (const row of rows) {
      const t = this.toText(row._time);
      const v = this.normalizeSampleValue(row._value);
      if (t != null && typeof v === 'number' && Number.isFinite(v)) {
        out.push({ timestamp: t, value: v });
      }
    }
    return out;
  }

  /**
   * Detects step changes in a time series.
   *
   * Down-samples the field to `every` buckets (using `last`), runs `difference()`,
   * keeps deltas whose absolute value is ≥ `minDelta`, and returns up to `limit`
   * timestamps with their delta values, oldest first.
   *
   * `kind`:
   *   - 'step_up'   → keep deltas ≥ +minDelta  (fuel bunkering, tank fill, counter reset upward)
   *   - 'step_down' → keep deltas ≤ -minDelta  (tank drain, sudden discharge)
   *   - 'both'      → keep |delta| ≥ minDelta
   */
  async queryStepChanges(
    orgName: string,
    metric: InfluxMetricSelector,
    start: Date,
    end: Date,
    opts: {
      every?: string;
      kind?: 'step_up' | 'step_down' | 'both';
      minDelta: number;
      limit?: number;
    },
  ): Promise<Array<{ timestamp: string; delta: number }>> {
    const every = opts.every ?? '30m';
    const kind = opts.kind ?? 'step_up';
    const limit = Math.max(1, Math.min(50, opts.limit ?? 10));

    let filterExpr: string;
    if (kind === 'step_up') {
      filterExpr = `r._value >= ${opts.minDelta}`;
    } else if (kind === 'step_down') {
      filterExpr = `r._value <= ${-opts.minDelta}`;
    } else {
      filterExpr = `r._value >= ${opts.minDelta} or r._value <= ${-opts.minDelta}`;
    }

    const flux = [
      `from(bucket: ${this.toFluxString(metric.bucket)})`,
      `|> range(start: ${this.toFluxAbsoluteTime(start)}, stop: ${this.toFluxAbsoluteTime(end)})`,
      `|> filter(fn: (r) => r._measurement == ${this.toFluxString(metric.measurement)} and r._field == ${this.toFluxString(metric.field)})`,
      `|> aggregateWindow(every: ${every}, fn: last, createEmpty: false)`,
      '|> difference()',
      `|> filter(fn: (r) => ${filterExpr})`,
      // Newest first so callers with a limit never miss recent events.
      '|> sort(columns: ["_time"], desc: true)',
      `|> limit(n: ${limit})`,
      '|> keep(columns: ["_time", "_value"])',
    ].join('\n');

    const rows = await this.queryRows(flux, orgName);
    const out: Array<{ timestamp: string; delta: number }> = [];
    for (const row of rows) {
      const t = this.toText(row._time);
      const v = this.normalizeSampleValue(row._value);
      if (t != null && typeof v === 'number' && Number.isFinite(v)) {
        out.push({ timestamp: t, delta: v });
      }
    }
    // Return ascending (oldest → newest) so callers can group by day naturally.
    out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return out;
  }

  /**
   * Timestamp of the first sample whose value satisfies a threshold
   * predicate (default: != 0). Useful for "when did this alarm first trip
   * in the window?" without pulling the entire series.
   */
  async queryFirstThresholdCrossing(
    orgName: string,
    metric: InfluxMetricSelector,
    start: Date,
    end: Date,
    opts: {
      direction?: 'above' | 'below' | 'nonzero';
      threshold?: number;
    } = {},
  ): Promise<{ timestamp: string; value: number } | null> {
    const direction = opts.direction ?? 'nonzero';
    const threshold = opts.threshold ?? 0;
    let predicate: string;
    if (direction === 'above') predicate = `r._value > ${threshold}`;
    else if (direction === 'below') predicate = `r._value < ${threshold}`;
    else predicate = `r._value != 0`;

    const flux = [
      `from(bucket: ${this.toFluxString(metric.bucket)})`,
      `|> range(start: ${this.toFluxAbsoluteTime(start)}, stop: ${this.toFluxAbsoluteTime(end)})`,
      `|> filter(fn: (r) => r._measurement == ${this.toFluxString(metric.measurement)} and r._field == ${this.toFluxString(metric.field)})`,
      `|> filter(fn: (r) => ${predicate})`,
      '|> sort(columns: ["_time"])',
      '|> limit(n: 1)',
      '|> keep(columns: ["_time", "_value"])',
    ].join('\n');

    const rows = await this.queryRows(flux, orgName);
    const row = rows[0];
    if (!row) return null;
    const t = this.toText(row._time);
    const v = this.normalizeSampleValue(row._value);
    if (t == null || typeof v !== 'number' || !Number.isFinite(v)) return null;
    return { timestamp: t, value: v };
  }

  /**
   * Count of consecutive transitions where the value crossed a threshold.
   * Useful for "how many times did engine temp exceed 90°C in the window".
   * Returns the count plus the first N (default 10) crossing timestamps.
   */
  async queryThresholdCrossings(
    orgName: string,
    metric: InfluxMetricSelector,
    start: Date,
    end: Date,
    opts: {
      direction: 'above' | 'below';
      threshold: number;
      every?: string;
      limit?: number;
    },
  ): Promise<Array<{ timestamp: string; value: number }>> {
    const every = opts.every ?? '1m';
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    // We sample at `every`, then keep points where (was below/above) AND
    // (current sample is above/below) — i.e. transitions through threshold.
    const op = opts.direction === 'above' ? '>' : '<';
    const flux = [
      `from(bucket: ${this.toFluxString(metric.bucket)})`,
      `|> range(start: ${this.toFluxAbsoluteTime(start)}, stop: ${this.toFluxAbsoluteTime(end)})`,
      `|> filter(fn: (r) => r._measurement == ${this.toFluxString(metric.measurement)} and r._field == ${this.toFluxString(metric.field)})`,
      `|> aggregateWindow(every: ${every}, fn: last, createEmpty: false)`,
      `|> map(fn: (r) => ({_time: r._time, _value: r._value, _crossed: if r._value ${op} ${opts.threshold} then 1.0 else 0.0}))`,
      '|> difference(columns: ["_crossed"])',
      `|> filter(fn: (r) => r._crossed == 1.0)`,
      '|> sort(columns: ["_time"], desc: true)',
      `|> limit(n: ${limit})`,
      '|> keep(columns: ["_time", "_value"])',
    ].join('\n');
    const rows = await this.queryRows(flux, orgName);
    const out: Array<{ timestamp: string; value: number }> = [];
    for (const row of rows) {
      const t = this.toText(row._time);
      const v = this.normalizeSampleValue(row._value);
      if (t != null && typeof v === 'number' && Number.isFinite(v)) {
        out.push({ timestamp: t, value: v });
      }
    }
    out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return out;
  }

  /**
   * Public escape hatch for raw Flux. Wraps the private queryRows so the
   * analyzer's `run_flux_query` tool can run user-provided Flux without
   * being constrained to the pre-built helpers. The row cap protects the
   * LLM context from being flooded by a runaway query.
   */
  async queryRawFlux(
    orgName: string,
    flux: string,
    maxRows: number = 200,
  ): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
    const rows = await this.queryRows(flux, orgName);
    const truncated = rows.length > maxRows;
    return { rows: truncated ? rows.slice(0, maxRows) : rows, truncated };
  }

  getStatus(): IntegrationStatusDto {
    const hasConnectionConfig = Boolean(
      this.configService.get<string>('integrations.influx.url') &&
        this.configService.get<string>('integrations.influx.org') &&
        this.configService.get<string>('integrations.influx.token'),
    );

    return {
      name: 'influx',
      configured: hasConnectionConfig,
      reachable: false,
      details: !hasConnectionConfig
        ? 'Influx connection configuration is missing.'
        : 'Influx connection is configured. Organization discovery is read from the Influx org API.',
    };
  }

  private get influx() {
    if (this.influxClient) {
      return this.influxClient;
    }

    const url = this.configService.get<string>('integrations.influx.url', '');
    const token = this.configService.get<string>('integrations.influx.token', '');

    if (!url || !token) {
      throw new Error('Influx connection is not configured');
    }

    this.influxClient = new InfluxDB({
      url,
      token,
      timeout: 30_000,
    });

    return this.influxClient;
  }

  private async listMeasurements(
    orgName: string,
    bucket: string,
  ): Promise<string[]> {
    const flux = [
      'import "influxdata/influxdb/schema"',
      `schema.measurements(bucket: ${this.toFluxString(bucket)}, start: ${this.toFluxTime(
        this.configService.get<string>(
          'integrations.influx.schemaLookback',
          '-365d',
        ),
      )})`,
    ].join('\n');

    const rows = await this.queryRows(flux, orgName);
    return [...new Set(rows.map((row) => this.toText(row._value)).filter(Boolean))].sort(
      (left, right) => left.localeCompare(right),
    );
  }

  private async listFieldKeys(
    orgName: string,
    bucket: string,
    measurement: string,
  ): Promise<string[]> {
    const flux = [
      'import "influxdata/influxdb/schema"',
      `schema.fieldKeys(bucket: ${this.toFluxString(bucket)}, start: ${this.toFluxTime(
        this.configService.get<string>(
          'integrations.influx.schemaLookback',
          '-365d',
        ),
      )}, predicate: (r) => r._measurement == ${this.toFluxString(
        measurement,
      )})`,
    ].join('\n');

    const rows = await this.queryRows(flux, orgName);
    return [...new Set(rows.map((row) => this.toText(row._value)).filter(Boolean))].sort(
      (left, right) => left.localeCompare(right),
    );
  }

  private async queryRows(
    flux: string,
    orgName: string,
  ): Promise<Record<string, unknown>[]> {
    try {
      return await this.executeQueryRows(flux, orgName);
    } catch (error) {
      if (!this.isTimeoutError(error)) {
        throw error;
      }

      await this.delay(250);
      return this.executeQueryRows(flux, orgName);
    }
  }

  private async executeQueryRows(
    flux: string,
    orgName: string,
  ): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      const queryApi = this.influx.getQueryApi(orgName);

      queryApi.queryRows(flux, {
        next: (row, tableMeta) => {
          rows.push(tableMeta.toObject(row) as Record<string, unknown>);
        },
        error: (error) =>
          reject(error instanceof Error ? error : new Error(String(error))),
        complete: () => resolve(rows),
      });
    });
  }

  private isTimeoutError(error: unknown): boolean {
    return error instanceof Error
      ? error.message.toLowerCase().includes('timed out')
      : false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async queryMetricSample(
    orgName: string,
    metric: InfluxMetricSelector,
    options: {
      start: string;
      stop?: string;
    },
  ): Promise<InfluxMetricSample | null> {
    const flux = [
      `from(bucket: ${this.toFluxString(metric.bucket)})`,
      `|> range(start: ${this.toFluxTime(options.start)}${
        options.stop ? `, stop: ${options.stop}` : ''
      })`,
      `|> filter(fn: (r) => r._measurement == ${this.toFluxString(
        metric.measurement,
      )} and r._field == ${this.toFluxString(metric.field)})`,
      '|> group()',
      '|> sort(columns: ["_time"], desc: true)',
      '|> limit(n: 1)',
    ].join('\n');

    const rows = await this.queryRows(flux, orgName);
    const row = rows[0];

    if (!row) {
      return null;
    }

    const timestamp = this.toText(row._time);

    if (!timestamp) {
      return null;
    }

    return {
      bucket: metric.bucket,
      measurement: metric.measurement,
      field: metric.field,
      timestamp,
      value: this.normalizeSampleValue(row._value),
    };
  }

  private getQueryLookback(): string {
    return this.configService.get<string>(
      'integrations.influx.queryLookback',
      this.configService.get<string>(
        'integrations.influx.schemaLookback',
        '-365d',
      ),
    );
  }

  private toFluxString(value: string): string {
    return JSON.stringify(value);
  }

  private toFluxTime(value: string): string {
    const normalizedValue = value.trim();

    if (!normalizedValue) {
      throw new Error('Influx query time cannot be empty');
    }

    return normalizedValue;
  }

  private toFluxAbsoluteTime(value: Date): string {
    return `time(v: ${JSON.stringify(value.toISOString())})`;
  }

  private normalizeSampleValue(
    value: unknown,
  ): string | number | boolean | null {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }

    return null;
  }

  private toText(value: unknown): string {
    if (typeof value === 'string') {
      return value.trim();
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    return '';
  }
}
