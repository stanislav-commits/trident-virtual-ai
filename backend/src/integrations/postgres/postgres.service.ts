import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { IntegrationStatusDto } from '../../common/dto/integration-status.dto';

@Injectable()
export class PostgresService {
  constructor(
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  getStatus(): IntegrationStatusDto {
    const host = this.configService.get<string>('integrations.postgres.host');
    const database = this.configService.get<string>('integrations.postgres.name');
    const configured = Boolean(host && database);

    return {
      name: 'postgres',
      configured,
      reachable: this.dataSource.isInitialized,
      details: configured
        ? this.dataSource.isInitialized
          ? `PostgreSQL connection is active (${host}/${database}).`
          : 'PostgreSQL is configured but not connected.'
        : 'Database connection settings are not configured yet.',
    };
  }
}
