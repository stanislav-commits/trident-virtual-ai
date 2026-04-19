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

@Injectable()
export class InfluxService {
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
    const url = this.configService.get<string>('integrations.influx.url', '');
    const token = this.configService.get<string>('integrations.influx.token', '');

    if (!url || !token) {
      throw new Error('Influx connection is not configured');
    }

    return new InfluxDB({
      url,
      token,
      timeout: 30_000,
    });
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
