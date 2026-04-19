import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { ShipEntity } from './entities/ship.entity';
import { type ShipResponseDto, toShipResponse } from './ship-response.mapper';

@Injectable()
export class ShipsQueryService {
  constructor(
    @InjectRepository(ShipEntity)
    private readonly shipsRepository: Repository<ShipEntity>,
  ) {}

  async listForUser(user: AuthenticatedUser): Promise<ShipResponseDto[]> {
    if (user.role === UserRole.ADMIN) {
      const ships = await this.shipsRepository.find({
        order: { name: 'ASC' },
      });

      return ships.map(toShipResponse);
    }

    if (!user.shipId) {
      return [];
    }

    const ship = await this.findById(user.shipId);
    return ship ? [toShipResponse(ship)] : [];
  }

  async getAccessibleShip(
    id: string,
    user: AuthenticatedUser,
  ): Promise<ShipResponseDto> {
    const ship = await this.findRequiredById(id);

    if (user.role === UserRole.USER && user.shipId !== ship.id) {
      throw new NotFoundException('Ship not found');
    }

    return toShipResponse(ship);
  }

  async findById(id: string): Promise<ShipEntity | null> {
    return this.shipsRepository.findOne({ where: { id } });
  }

  async count(): Promise<number> {
    return this.shipsRepository.count();
  }

  private async findRequiredById(id: string): Promise<ShipEntity> {
    const ship = await this.findById(id);

    if (!ship) {
      throw new NotFoundException('Ship not found');
    }

    return ship;
  }
}
