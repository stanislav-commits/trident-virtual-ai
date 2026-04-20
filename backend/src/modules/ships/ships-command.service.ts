import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MetricsCatalogService } from '../metrics/metrics-catalog.service';
import { UserRole } from '../../common/enums/user-role.enum';
import { UserEntity } from '../users/entities/user.entity';
import { CreateShipDto } from './dto/create-ship.dto';
import { UpdateShipDto } from './dto/update-ship.dto';
import { ShipEntity } from './entities/ship.entity';
import { type ShipResponseDto, toShipResponse } from './ship-response.mapper';

@Injectable()
export class ShipsCommandService {
  constructor(
    @InjectRepository(ShipEntity)
    private readonly shipsRepository: Repository<ShipEntity>,
    @InjectRepository(UserEntity)
    private readonly usersRepository: Repository<UserEntity>,
    private readonly metricsCatalogService: MetricsCatalogService,
  ) {}

  async create(input: CreateShipDto): Promise<ShipResponseDto> {
    const discoveredMetrics = await this.metricsCatalogService.discoverOrganizationMetrics(
      input.organizationName,
    );

    const ship = this.shipsRepository.create({
      name: input.name,
      organizationName: input.organizationName,
      imoNumber: input.imoNumber ?? null,
      buildYear: input.buildYear ?? null,
    });

    const savedShip = await this.shipsRepository.save(ship);
    await this.metricsCatalogService.syncShipCatalog(savedShip.id, discoveredMetrics);
    return toShipResponse(savedShip);
  }

  async update(id: string, input: UpdateShipDto): Promise<ShipResponseDto> {
    const ship = await this.shipsRepository.findOne({ where: { id } });

    if (!ship) {
      throw new NotFoundException('Ship not found');
    }

    const nextOrganizationName =
      typeof input.organizationName === 'string'
        ? input.organizationName
        : ship.organizationName;
    const hadOrganizationName = Boolean(ship.organizationName);
    const organizationChanged =
      typeof input.organizationName === 'string' &&
      input.organizationName !== ship.organizationName;
    const discoveredMetrics = organizationChanged
      ? await this.metricsCatalogService.discoverOrganizationMetrics(
          nextOrganizationName ?? '',
        )
      : undefined;

    if (typeof input.name === 'string') {
      ship.name = input.name;
    }

    if (typeof input.organizationName === 'string') {
      ship.organizationName = input.organizationName;
    }

    if (input.imoNumber !== undefined) {
      ship.imoNumber = input.imoNumber ?? null;
    }

    if (input.buildYear !== undefined) {
      ship.buildYear = input.buildYear ?? null;
    }

    const savedShip = await this.shipsRepository.save(ship);
    if (nextOrganizationName && (organizationChanged || !hadOrganizationName)) {
      await this.metricsCatalogService.syncShipCatalog(
        savedShip.id,
        discoveredMetrics,
      );
    }

    return toShipResponse(savedShip);
  }

  async remove(id: string): Promise<void> {
    const ship = await this.shipsRepository.findOne({ where: { id } });

    if (!ship) {
      throw new NotFoundException('Ship not found');
    }

    const assignedUsersCount = await this.usersRepository.count({
      where: {
        shipId: id,
        role: UserRole.USER,
      },
    });

    if (assignedUsersCount > 0) {
      throw new BadRequestException(
        `Cannot delete this ship while ${assignedUsersCount} user${assignedUsersCount === 1 ? '' : 's'} ${assignedUsersCount === 1 ? 'is' : 'are'} assigned to it. Reassign or remove those users first.`,
      );
    }

    await this.shipsRepository.remove(ship);
  }
}
