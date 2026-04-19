import { Injectable, Logger } from '@nestjs/common';
import { InfluxService } from '../../integrations/influx/influx.service';

@Injectable()
export class ShipOrganizationsService {
  private readonly logger = new Logger(ShipOrganizationsService.name);

  constructor(private readonly influxService: InfluxService) {}

  async list(): Promise<string[]> {
    try {
      return await this.influxService.listOrganizations();
    } catch (error) {
      this.logger.warn(
        error instanceof Error
          ? `Failed to load organizations from Influx: ${error.message}`
          : 'Failed to load organizations from Influx',
      );

      return [];
    }
  }
}
