import { Injectable, ServiceUnavailableException } from '@nestjs/common';
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

@Injectable()
export class InfluxdbService {
  private readonly influxUrl = process.env.INFLUX_URL;
  private readonly influxToken = process.env.INFLUX_TOKEN;
  private readonly influxOrg = process.env.INFLUX_ORG;
  private readonly schemaLookback =
    process.env.INFLUX_SCHEMA_LOOKBACK ?? '-365d';

  private readonly configuredBuckets =
    process.env.INFLUX_BUCKETS?.split(',')
      .map((part) => part.trim())
      .filter(Boolean) ?? [];

  private get influx() {
    if (!this.influxUrl || !this.influxToken || !this.influxOrg) {
      throw new ServiceUnavailableException(
        'InfluxDB is not configured. Expected INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG',
      );
    }
    // The SDK constructor is loosely typed in current package typings.
    /* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
    return new InfluxDB({
      url: this.influxUrl,
      token: this.influxToken,
    });
    /* eslint-enable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call */
  }

  isConfigured(): boolean {
    return Boolean(this.influxUrl && this.influxToken && this.influxOrg);
  }

  getBuckets(): string[] {
    if (this.configuredBuckets.length > 0) {
      return this.configuredBuckets;
    }
    return ['Trending', 'NMEA'];
  }

  async listAllMetrics(): Promise<InfluxMetric[]> {
    const buckets = this.getBuckets();
    const allMetrics: InfluxMetric[] = [];

    for (const bucket of buckets) {
      const measurements = await this.listMeasurements(bucket);
      for (const measurement of measurements) {
        const fields = await this.listFieldKeys(bucket, measurement);
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

  /**
   * Fetch the latest value for each metric key.
   * Keys are in the format "bucket::measurement::field".
   */
  async queryLatestValues(keys: string[]): Promise<InfluxMetricValue[]> {
    if (!keys.length) return [];

    // Group keys by bucket for efficient queries
    const byBucket = new Map<
      string,
      { measurement: string; field: string; key: string }[]
    >();
    for (const key of keys) {
      const parts = key.split('::');
      if (parts.length !== 3) continue;
      const [bucket, measurement, field] = parts;
      if (!byBucket.has(bucket)) byBucket.set(bucket, []);
      byBucket.get(bucket)!.push({ measurement, field, key });
    }

    const results: InfluxMetricValue[] = [];

    for (const [bucket, metrics] of byBucket) {
      // Build a combined filter for all measurements+fields in this bucket
      const filterClauses = metrics
        .map(
          (m) =>
            `(r._measurement == ${this.toFluxString(m.measurement)} and r._field == ${this.toFluxString(m.field)})`,
        )
        .join(' or ');

      const flux = [
        `from(bucket: ${this.toFluxString(bucket)})`,
        '  |> range(start: -24h)',
        `  |> filter(fn: (r) => ${filterClauses})`,
        '  |> last()',
      ].join('\n');

      const rows = await this.queryRows(flux);

      for (const row of rows) {
        const measurement = this.toText(row._measurement);
        const field = this.toText(row._field);
        const matchedMetric = metrics.find(
          (m) => m.measurement === measurement && m.field === field,
        );
        if (!matchedMetric) continue;

        results.push({
          key: matchedMetric.key,
          bucket,
          measurement,
          field,
          value: row._value as number | string | boolean | null,
          time: this.toText(row._time),
        });
      }
    }

    return results;
  }

  private async listMeasurements(bucket: string): Promise<string[]> {
    const flux = [
      'import "influxdata/influxdb/schema"',
      `schema.measurements(bucket: ${this.toFluxString(bucket)}, start: ${this.schemaLookback})`,
    ].join('\n');

    const rows = await this.queryRows(flux);
    const measurements = rows
      .map((row) => this.toText(row._value))
      .filter(Boolean);

    return [...new Set(measurements)];
  }

  private async listFieldKeys(
    bucket: string,
    measurement: string,
  ): Promise<string[]> {
    const flux = [
      'import "influxdata/influxdb/schema"',
      `schema.fieldKeys(bucket: ${this.toFluxString(bucket)}, start: ${this.schemaLookback}, predicate: (r) => r._measurement == ${this.toFluxString(measurement)})`,
    ].join('\n');

    const rows = await this.queryRows(flux);
    const fields = rows.map((row) => this.toText(row._value)).filter(Boolean);

    return [...new Set(fields)];
  }

  private async queryRows(flux: string): Promise<Record<string, unknown>[]> {
    return new Promise((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      // The upstream client exposes callback metadata loosely typed.
      /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
      const queryApi = this.influx.getQueryApi(this.influxOrg!);

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

  private toFluxString(value: string): string {
    return JSON.stringify(value);
  }

  private toText(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    return '';
  }
}
