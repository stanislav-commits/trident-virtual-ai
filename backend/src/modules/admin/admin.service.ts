import { Injectable } from '@nestjs/common';
import { HealthService } from '../../core/health/health.service';
import { ShipsQueryService } from '../ships/ships-query.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class AdminService {
  constructor(
    private readonly healthService: HealthService,
    private readonly usersService: UsersService,
    private readonly shipsQueryService: ShipsQueryService,
  ) {}

  async getOverview() {
    return {
      status: 'scaffolded',
      managedAreas: ['metrics-catalog', 'documents-metadata', 'system-overrides', 'integrations'],
      accessModel: {
        admin: 'full-access-to-all-ships',
        user: 'restricted-to-assigned-ship',
      },
      totals: {
        users: await this.usersService.count(),
        ships: await this.shipsQueryService.count(),
      },
      health: this.healthService.getHealth(),
    };
  }
}
