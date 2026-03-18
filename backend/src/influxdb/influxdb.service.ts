import {
  HttpException,
  Injectable,
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

interface InfluxOrganizationsResponse {
  orgs?: Array<{ name?: string | null }>;
}

interface InfluxBucketsResponse {
  buckets?: Array<{ name?: string | null }>;
}

@Injectable()
export class InfluxdbService {
  private readonly latestValuesBatchSize = 100;
  private readonly influxUrl = process.env.INFLUX_URL;
  private readonly influxToken = process.env.INFLUX_TOKEN;
  private readonly defaultOrg = process.env.INFLUX_ORG;
  private readonly configuredOrganizations =
    process.env.INFLUX_ORGANIZATIONS?.split(',')
      .map((value) => value.trim())
      .filter(Boolean) ?? [];
  private readonly schemaLookback =
    process.env.INFLUX_SCHEMA_LOOKBACK ?? '-365d';

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

        for (const metricsBatch of this.chunk(metrics, this.latestValuesBatchSize)) {
          const fieldFilter =
            metricsBatch.length === 1
              ? `r._field == ${this.toFluxString(metricsBatch[0].field)}`
              : `contains(value: r._field, set: [${metricsBatch
                  .map((metric) => this.toFluxString(metric.field))
                  .join(', ')}])`;

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
}
