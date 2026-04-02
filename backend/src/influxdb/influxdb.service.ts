import {
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InfluxDB } from '@influxdata/influxdb-client';

export interface InfluxMetric {
  key: string;
  bucket: string;
  measurement: string;
  field: string;
  label: string;
}

export interface InfluxMetricValue {
  key: string;
  bucket: string;
  measurement: string;
  field: string;
  value: number | string | boolean | null;
  time: string;
}

export interface InfluxHistoricalQueryRange {
  start: Date | string;
  stop: Date | string;
}

export interface InfluxHistoricalSeriesOptions {
  windowEvery?: string;
}

export interface InfluxHistoricalAggregateValue extends InfluxMetricValue {}

export interface InfluxHistoricalFirstLastValues {
  first: InfluxMetricValue[];
  last: InfluxMetricValue[];
}

interface InfluxOrganizationsResponse {
  orgs?: Array<{ name?: string | null }>;
}

interface InfluxBucketsResponse {
  buckets?: Array<{ name?: string | null }>;
}

@Injectable()
export class InfluxdbService {
  private readonly logger = new Logger(InfluxdbService.name);
  private readonly latestValuesBatchSize = this.readIntEnv(
    'INFLUX_LATEST_VALUES_BATCH_SIZE',
    50,
    1,
    500,
  );
  private readonly influxTimeoutMs = this.readIntEnv(
    'INFLUX_TIMEOUT_MS',
    30000,
    1000,
    300000,
  );
  private readonly influxUrl = process.env.INFLUX_URL;
  private readonly influxToken = process.env.INFLUX_TOKEN;
  private readonly defaultOrg = process.env.INFLUX_ORG;
  private readonly configuredOrganizations =
    process.env.INFLUX_ORGANIZATIONS?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  private readonly schemaLookback =
    process.env.INFLUX_SCHEMA_LOOKBACK ?? '-365d';

  private readIntEnv(
    name: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const raw = process.env[name];
    if (!raw) return fallback;

    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      this.logger.warn(
        `Ignoring invalid ${name} value "${raw}", using fallback ${fallback}`,
      );
      return fallback;
    }

    if (parsed < min || parsed > max) {
      this.logger.warn(
        `Ignoring out-of-range ${name} value "${raw}", expected ${min}-${max}, using fallback ${fallback}`,
      );
      return fallback;
    }

    return parsed;
  }

  private get influx() {
    if (!this.influxUrl || !this.influxToken) {
      throw new ServiceUnavailableException(
        'InfluxDB is not configured. Expected INFLUX_URL and INFLUX_TOKEN',
      );
    }
    /* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
    return new InfluxDB({
      url: this.influxUrl,
      token: this.influxToken,
      timeout: this.influxTimeoutMs,
    });
    /* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
  }

  isConfigured(): boolean {
    return Boolean(this.influxUrl && this.influxToken);
  }

  async listOrganizations(): Promise<string[]> {
    try {
      const response = await this.requestJson<InfluxOrganizationsResponse>(
        '/api/v2/orgs',
        { limit: '100' },
      );

      const organizations = [
        ...new Set(
          (response.orgs ?? [])
            .map((org) => this.toText(org.name))
            .filter(Boolean),
        ),
      ].sort((left, right) => left.localeCompare(right));

      if (organizations.length > 0) {
        return organizations;
      }
    } catch (error) {
      const fallbackOrganizations = this.getFallbackOrganizations();
      if (fallbackOrganizations.length > 0) {
        return fallbackOrganizations;
      }
      throw error;
    }

    return this.getFallbackOrganizations();
  }

  async listBuckets(orgName: string): Promise<string[]> {
    const response = await this.requestJson<InfluxBucketsResponse>(
      '/api/v2/buckets',
      { org: orgName, limit: '100' },
    );

    return [
      ...new Set(
        (response.buckets ?? [])
          .map((bucket) => this.toText(bucket.name))
          .filter(Boolean),
      ),
    ]
      .filter((bucket) => !bucket.startsWith('_'))
      .sort((left, right) => left.localeCompare(right));
  }

  async listAllMetrics(orgName: string): Promise<InfluxMetric[]> {
    const buckets = await this.listBuckets(orgName);
    const allMetrics: InfluxMetric[] = [];

    for (const bucket of buckets) {
      const measurements = await this.listMeasurements(orgName, bucket);
      for (const measurement of measurements) {
        const fields = await this.listFieldKeys(orgName, bucket, measurement);
        for (const field of fields) {
          allMetrics.push({
            key: `${bucket}::${measurement}::${field}`,
            bucket,
            measurement,
            field,
            label: `${measurement}.${field}`,
          });
        }
      }
    }

    return allMetrics;
  }

  async queryLatestValues(
    keys: string[],
    orgName?: string,
  ): Promise<InfluxMetricValue[]> {
    if (!keys.length) return [];

    const effectiveOrg = orgName?.trim() || this.defaultOrg?.trim();
    if (!effectiveOrg) {
      throw new ServiceUnavailableException(
        'InfluxDB organization is not configured for this query',
      );
    }

    const byBucket = new Map<
      string,
      Map<string, { field: string; key: string }[]>
    >();
    for (const key of keys) {
      const parts = key.split('::');
      if (parts.length !== 3) continue;
      const [bucket, measurement, field] = parts;
      if (!byBucket.has(bucket)) {
        byBucket.set(bucket, new Map());
      }
      const byMeasurement = byBucket.get(bucket);
      if (!byMeasurement?.has(measurement)) {
        byMeasurement?.set(measurement, []);
      }
      byMeasurement?.get(measurement)?.push({ field, key });
    }

    const results: InfluxMetricValue[] = [];

    for (const [bucket, byMeasurement] of byBucket) {
      for (const [measurement, metrics] of byMeasurement) {
        const metricKeyByField = new Map(
          metrics.map((metric) => [metric.field, metric.key]),
        );

        for (const metricsBatch of this.chunk(
          metrics,
          this.latestValuesBatchSize,
        )) {
          const fieldFilter = this.buildFieldFilter(metricsBatch);

          const flux = [
            `from(bucket: ${this.toFluxString(bucket)})`,
            '  |> range(start: -24h)',
            `  |> filter(fn: (r) => r._measurement == ${this.toFluxString(measurement)})`,
            `  |> filter(fn: (r) => ${fieldFilter})`,
            '  |> last()',
          ].join('\n');

          const rows = await this.queryRows(flux, effectiveOrg);

          for (const row of rows) {
            const field = this.toText(row._field);
            const matchedMetricKey = metricKeyByField.get(field);
            if (!matchedMetricKey) continue;

            results.push({
              key: matchedMetricKey,
              bucket,
              measurement,
              field,
              value: row._value as number | string | boolean | null,
              time: this.toText(row._time),
            });
          }
        }
      }
    }

    return results;
  }

  async queryHistoricalSeries(
    keys: string[],
    range: InfluxHistoricalQueryRange,
    orgName?: string,
    options?: InfluxHistoricalSeriesOptions,
  ): Promise<InfluxMetricValue[]> {
    return this.queryHistoricalRows(keys, range, orgName, options);
  }

  async queryHistoricalAggregate(
    keys: string[],
    range: InfluxHistoricalQueryRange,
    aggregate: 'mean' | 'min' | 'max' | 'sum',
    orgName?: string,
  ): Promise<InfluxHistoricalAggregateValue[]> {
    if (!keys.length) return [];

    const effectiveOrg = orgName?.trim() || this.defaultOrg?.trim();
    if (!effectiveOrg) {
      throw new ServiceUnavailableException(
        'InfluxDB organization is not configured for this query',
      );
    }

    const byBucket = this.groupMetricKeys(keys);
    const results: InfluxHistoricalAggregateValue[] = [];

    for (const [bucket, byMeasurement] of byBucket) {
      for (const [measurement, metrics] of byMeasurement) {
        const metricKeyByField = new Map(
          metrics.map((metric) => [metric.field, metric.key]),
        );

        for (const metricsBatch of this.chunk(
          metrics,
          this.latestValuesBatchSize,
        )) {
          const fieldFilter = this.buildFieldFilter(metricsBatch);

          const flux = [
            `from(bucket: ${this.toFluxString(bucket)})`,
            `  |> range(start: ${this.toFluxTime(range.start)}, stop: ${this.toFluxTime(range.stop)})`,
            `  |> filter(fn: (r) => r._measurement == ${this.toFluxString(measurement)})`,
            `  |> filter(fn: (r) => ${fieldFilter})`,
            `  |> ${aggregate}()`,
          ].join('\n');

          this.logger.debug(
            `Influx historical aggregate query org=${effectiveOrg} bucket=${bucket} measurement=${measurement} aggregate=${aggregate} metrics=${metricsBatch.length} start=${this.toFluxTime(
              range.start,
            )} stop=${this.toFluxTime(range.stop)}`,
          );
          const rows = await this.queryRows(flux, effectiveOrg);
          this.logger.debug(
            `Influx historical aggregate result org=${effectiveOrg} bucket=${bucket} measurement=${measurement} aggregate=${aggregate} rows=${rows.length}`,
          );

          for (const row of rows) {
            const field = this.toText(row._field);
            const matchedMetricKey = metricKeyByField.get(field);
            if (!matchedMetricKey) continue;

            results.push({
              key: matchedMetricKey,
              bucket,
              measurement,
              field,
              value: row._value as number | string | boolean | null,
              time: this.toText(row._time),
            });
          }
        }
      }
    }

    return results;
  }

  async queryHistoricalFirstLast(
    keys: string[],
    range: InfluxHistoricalQueryRange,
    orgName?: string,
  ): Promise<InfluxHistoricalFirstLastValues> {
    return {
      first: await this.queryHistoricalBoundaryValues(
        'first',
        keys,
        range,
        orgName,
      ),
      last: await this.queryHistoricalBoundaryValues(
        'last',
        keys,
        range,
        orgName,
      ),
    };
  }

  async queryHistoricalNearestValues(
    keys: string[],
    pointInTime: Date,
    orgName?: string,
    windowMs = 12 * 60 * 60 * 1000,
  ): Promise<InfluxMetricValue[]> {
    if (!keys.length) return [];

    const beforeRange = {
      start: new Date(pointInTime.getTime() - windowMs),
      stop: new Date(pointInTime.getTime() + 1),
    };
    const afterRange = {
      start: pointInTime,
      stop: new Date(pointInTime.getTime() + windowMs),
    };

    this.logger.debug(
      `Influx historical nearest query point=${pointInTime.toISOString()} windowMs=${windowMs} keys=${keys.length}`,
    );
    const [previousRows, nextRows] = await Promise.all([
      this.queryHistoricalBoundaryValues('last', keys, beforeRange, orgName),
      this.queryHistoricalBoundaryValues('first', keys, afterRange, orgName),
    ]);
    const rows = [...previousRows, ...nextRows];
    this.logger.debug(
      `Influx historical nearest result point=${pointInTime.toISOString()} rows=${rows.length}`,
    );
    return rows;
  }

  private async listMeasurements(
    orgName: string,
    bucket: string,
  ): Promise<string[]> {
    const flux = [
      'import "influxdata/influxdb/schema"',
      `schema.measurements(bucket: ${this.toFluxString(bucket)}, start: ${this.schemaLookback})`,
    ].join('\n');

    const rows = await this.queryRows(flux, orgName);
    const measurements = rows
      .map((row) => this.toText(row._value))
      .filter(Boolean);

    return [...new Set(measurements)];
  }

  private async listFieldKeys(
    orgName: string,
    bucket: string,
    measurement: string,
  ): Promise<string[]> {
    const flux = [
      'import "influxdata/influxdb/schema"',
      `schema.fieldKeys(bucket: ${this.toFluxString(bucket)}, start: ${this.schemaLookback}, predicate: (r) => r._measurement == ${this.toFluxString(measurement)})`,
    ].join('\n');

    const rows = await this.queryRows(flux, orgName);
    const fields = rows.map((row) => this.toText(row._value)).filter(Boolean);

    return [...new Set(fields)];
  }

  private async queryHistoricalRows(
    keys: string[],
    range: InfluxHistoricalQueryRange,
    orgName?: string,
    options?: InfluxHistoricalSeriesOptions,
  ): Promise<InfluxMetricValue[]> {
    if (!keys.length) return [];

    const effectiveOrg = orgName?.trim() || this.defaultOrg?.trim();
    if (!effectiveOrg) {
      throw new ServiceUnavailableException(
        'InfluxDB organization is not configured for this query',
      );
    }

    const byBucket = this.groupMetricKeys(keys);
    const results: InfluxMetricValue[] = [];

    for (const [bucket, byMeasurement] of byBucket) {
      for (const [measurement, metrics] of byMeasurement) {
        const metricKeyByField = new Map(
          metrics.map((metric) => [metric.field, metric.key]),
        );

        for (const metricsBatch of this.chunk(
          metrics,
          this.latestValuesBatchSize,
        )) {
          const fieldFilter = this.buildFieldFilter(metricsBatch);

          const flux = [
            `from(bucket: ${this.toFluxString(bucket)})`,
            `  |> range(start: ${this.toFluxTime(range.start)}, stop: ${this.toFluxTime(range.stop)})`,
            `  |> filter(fn: (r) => r._measurement == ${this.toFluxString(measurement)})`,
            `  |> filter(fn: (r) => ${fieldFilter})`,
            ...(options?.windowEvery
              ? [
                  `  |> aggregateWindow(every: ${options.windowEvery}, fn: last, createEmpty: false)`,
                ]
              : []),
          ].join('\n');

          this.logger.debug(
            `Influx historical series query org=${effectiveOrg} bucket=${bucket} measurement=${measurement} metrics=${metricsBatch.length} window=${options?.windowEvery ?? 'raw'} start=${this.toFluxTime(
              range.start,
            )} stop=${this.toFluxTime(range.stop)}`,
          );
          const rows = await this.queryRows(flux, effectiveOrg);
          this.logger.debug(
            `Influx historical series result org=${effectiveOrg} bucket=${bucket} measurement=${measurement} rows=${rows.length}`,
          );
          for (const row of rows) {
            const field = this.toText(row._field);
            const matchedMetricKey = metricKeyByField.get(field);
            if (!matchedMetricKey) continue;

            results.push({
              key: matchedMetricKey,
              bucket,
              measurement,
              field,
              value: row._value as number | string | boolean | null,
              time: this.toText(row._time),
            });
          }
        }
      }
    }

    return results;
  }

  private async queryHistoricalBoundaryValues(
    boundary: 'first' | 'last',
    keys: string[],
    range: InfluxHistoricalQueryRange,
    orgName?: string,
  ): Promise<InfluxMetricValue[]> {
    if (!keys.length) return [];

    const effectiveOrg = orgName?.trim() || this.defaultOrg?.trim();
    if (!effectiveOrg) {
      throw new ServiceUnavailableException(
        'InfluxDB organization is not configured for this query',
      );
    }

    const byBucket = this.groupMetricKeys(keys);
    const results: InfluxMetricValue[] = [];

    for (const [bucket, byMeasurement] of byBucket) {
      for (const [measurement, metrics] of byMeasurement) {
        const metricKeyByField = new Map(
          metrics.map((metric) => [metric.field, metric.key]),
        );

        for (const metricsBatch of this.chunk(
          metrics,
          this.latestValuesBatchSize,
        )) {
          const fieldFilter = this.buildFieldFilter(metricsBatch);

          const flux = [
            `from(bucket: ${this.toFluxString(bucket)})`,
            `  |> range(start: ${this.toFluxTime(range.start)}, stop: ${this.toFluxTime(range.stop)})`,
            `  |> filter(fn: (r) => r._measurement == ${this.toFluxString(measurement)})`,
            `  |> filter(fn: (r) => ${fieldFilter})`,
            `  |> ${boundary}()`,
          ].join('\n');

          this.logger.debug(
            `Influx historical boundary query org=${effectiveOrg} bucket=${bucket} measurement=${measurement} boundary=${boundary} metrics=${metricsBatch.length} start=${this.toFluxTime(
              range.start,
            )} stop=${this.toFluxTime(range.stop)}`,
          );
          const rows = await this.queryRows(flux, effectiveOrg);
          this.logger.debug(
            `Influx historical boundary result org=${effectiveOrg} bucket=${bucket} measurement=${measurement} boundary=${boundary} rows=${rows.length}`,
          );
          for (const row of rows) {
            const field = this.toText(row._field);
            const matchedMetricKey = metricKeyByField.get(field);
            if (!matchedMetricKey) continue;

            results.push({
              key: matchedMetricKey,
              bucket,
              measurement,
              field,
              value: row._value as number | string | boolean | null,
              time: this.toText(row._time),
            });
          }
        }
      }
    }

    return results;
  }

  private async queryRows(
    flux: string,
    orgName: string,
  ): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
      const queryApi = this.influx.getQueryApi(orgName);

      queryApi.queryRows(flux, {
        next: (row, tableMeta) => {
          rows.push(tableMeta.toObject(row) as Record<string, unknown>);
        },
        error: (error) =>
          reject(error instanceof Error ? error : new Error(String(error))),
        complete: () => resolve(rows),
      });
      /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
    });
  }

  private buildFieldFilter(
    metricsBatch: Array<{
      field: string;
    }>,
  ): string {
    if (metricsBatch.length === 1) {
      return `r._field == ${this.toFluxString(metricsBatch[0].field)}`;
    }

    return `(${metricsBatch
      .map((metric) => `r._field == ${this.toFluxString(metric.field)}`)
      .join(' or ')})`;
  }

  private async requestJson<T>(
    pathname: string,
    query?: Record<string, string>,
  ): Promise<T> {
    if (!this.influxUrl || !this.influxToken) {
      throw new ServiceUnavailableException(
        'InfluxDB is not configured. Expected INFLUX_URL and INFLUX_TOKEN',
      );
    }

    const url = new URL(pathname, this.influxUrl);
    Object.entries(query ?? {}).forEach(([key, value]) => {
      if (value.trim()) {
        url.searchParams.set(key, value);
      }
    });

    const response = await fetch(url, {
      headers: {
        Authorization: `Token ${this.influxToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new HttpException(
        body ||
          `InfluxDB request failed: ${response.status} ${response.statusText}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }

  private toFluxString(value: string): string {
    return JSON.stringify(value);
  }

  private toFluxTime(value: Date | string): string {
    if (value instanceof Date) {
      return value.toISOString();
    }

    const trimmed = value.trim();
    if (!trimmed) {
      throw new ServiceUnavailableException(
        'InfluxDB query time cannot be empty',
      );
    }

    if (/^[+-]?\d+[smhdw]$/i.test(trimmed)) {
      return trimmed;
    }

    if (
      /^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z$/i.test(trimmed) ||
      /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
    ) {
      return trimmed;
    }

    return trimmed;
  }

  private toText(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return '';
  }

  private getFallbackOrganizations(): string[] {
    return [
      ...new Set(
        [...this.configuredOrganizations, this.defaultOrg?.trim() ?? ''].filter(
          Boolean,
        ),
      ),
    ].sort((left, right) => left.localeCompare(right));
  }

  private chunk<T>(items: T[], size: number): T[][] {
    if (size <= 0 || items.length <= size) {
      return [items];
    }

    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      chunks.push(items.slice(index, index + size));
    }
    return chunks;
  }

  private groupMetricKeys(
    keys: string[],
  ): Map<string, Map<string, { field: string; key: string }[]>> {
    const byBucket = new Map<
      string,
      Map<string, { field: string; key: string }[]>
    >();

    for (const key of keys) {
      const parts = key.split('::');
      if (parts.length !== 3) continue;
      const [bucket, measurement, field] = parts;
      if (!byBucket.has(bucket)) {
        byBucket.set(bucket, new Map());
      }
      const byMeasurement = byBucket.get(bucket);
      if (!byMeasurement?.has(measurement)) {
        byMeasurement?.set(measurement, []);
      }
      byMeasurement?.get(measurement)?.push({ field, key });
    }

    return byBucket;
  }
}
