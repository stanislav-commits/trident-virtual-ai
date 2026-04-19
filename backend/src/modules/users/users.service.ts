import { randomBytes } from 'node:crypto';
import { hash } from 'bcryptjs';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { ShipsQueryService } from '../ships/ships-query.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserNameDto } from './dto/update-user-name.dto';
import { UserEntity } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly usersRepository: Repository<UserEntity>,
    private readonly shipsQueryService: ShipsQueryService,
  ) {}

  async list() {
    const users = await this.usersRepository.find({
      relations: { ship: true },
      order: { createdAt: 'DESC' },
    });

    return users.map((user) => this.toUserResponse(user));
  }

  async create(input: CreateUserDto) {
    await this.validateRoleScope(input.role, input.shipId);

    if (input.role === UserRole.USER && input.shipId) {
      const ship = await this.shipsQueryService.findById(input.shipId);

      if (!ship) {
        throw new BadRequestException('Ship not found');
      }
    }

    const userId = input.userId?.trim() || this.generateUserId(input.role);
    const password = input.password?.trim() || this.generatePassword();
    const passwordHash = await hash(password, 10);

    const entity = this.usersRepository.create({
      userId,
      name: input.name?.trim() || null,
      passwordHash,
      role: input.role,
      shipId: input.role === UserRole.ADMIN ? null : input.shipId ?? null,
    });

    const saved = await this.usersRepository.save(entity);

    return {
      id: saved.id,
      userId: saved.userId,
      password,
    };
  }

  async findByUserId(userId: string): Promise<UserEntity | null> {
    return this.usersRepository.findOne({
      where: { userId },
      relations: { ship: true },
    });
  }

  async findAuthUserById(id: string): Promise<AuthenticatedUser | null> {
    const user = await this.usersRepository.findOne({
      where: { id },
      relations: { ship: true },
    });

    return user ? this.toAuthUser(user) : null;
  }

  async me(user: AuthenticatedUser) {
    const entity = await this.usersRepository.findOne({
      where: { id: user.id },
      relations: { ship: true },
    });

    if (!entity) {
      throw new NotFoundException('User not found');
    }

    return { user: this.toUserResponse(entity) };
  }

  async updateName(id: string, input: UpdateUserNameDto) {
    const user = await this.usersRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    user.name = input.name?.trim() || null;
    const saved = await this.usersRepository.save(user);

    return {
      id: saved.id,
      userId: saved.userId,
      name: saved.name,
    };
  }

  async resetPassword(id: string) {
    const user = await this.usersRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const password = this.generatePassword();
    user.passwordHash = await hash(password, 10);
    await this.usersRepository.save(user);

    return {
      userId: user.userId,
      password,
    };
  }

  async delete(id: string): Promise<void> {
    const user = await this.usersRepository.findOne({ where: { id } });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.usersRepository.remove(user);
  }

  async count(): Promise<number> {
    return this.usersRepository.count();
  }

  toAuthUser(user: UserEntity): AuthenticatedUser {
    return {
      id: user.id,
      userId: user.userId,
      role: user.role,
      shipId: user.shipId,
      name: user.name,
    };
  }

  private toUserResponse(user: UserEntity) {
    return {
      id: user.id,
      userId: user.userId,
      name: user.name,
      role: user.role,
      shipId: user.shipId,
      createdAt: user.createdAt.toISOString(),
      ship: user.ship
        ? {
            id: user.ship.id,
            name: user.ship.name,
          }
        : null,
    };
  }

  private async validateRoleScope(role: UserRole, shipId?: string) {
    if (role === UserRole.USER && !shipId) {
      throw new BadRequestException('Regular users must be assigned to a ship');
    }

    if (role === UserRole.ADMIN && shipId) {
      throw new BadRequestException('Admins cannot be locked to a single ship');
    }
  }

  private generateUserId(role: UserRole): string {
    const suffix = randomBytes(3).toString('hex');
    return role === UserRole.ADMIN ? `admin-${suffix}` : `crew-${suffix}`;
  }

  private generatePassword(): string {
    return randomBytes(6).toString('base64url');
  }
}
