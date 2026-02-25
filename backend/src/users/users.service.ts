import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import type { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

function generateUserId(): string {
  return randomBytes(8).toString('base64url');
}

function generatePassword(): string {
  return randomBytes(12).toString('base64url');
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(role: Role, shipId?: string) {
    const userId = generateUserId();
    const plainPassword = generatePassword();
    const passwordHash = await bcrypt.hash(plainPassword, 10);
    // If creating a regular user, ensure ship-binding rules:
    if (role === 'user') {
      const shipsCount = await this.prisma.ship.count();
      if (shipsCount === 0) {
        throw new BadRequestException(
          'No ships exist; please add a ship first',
        );
      }
      if (!shipId) {
        throw new BadRequestException(
          'At least one ship exists; please select a ship to assign the user to',
        );
      }
      const ship = await this.prisma.ship.findUnique({ where: { id: shipId } });
      if (!ship) {
        throw new BadRequestException('Ship not found');
      }
    }

    const user = await this.prisma.user.create({
      data: {
        userId,
        passwordHash,
        role,
        shipId: role === 'user' ? (shipId ?? undefined) : undefined,
      },
    });
    return { id: user.id, userId: user.userId, password: plainPassword };
  }

  async findAll(excludeId: string) {
    const users = await this.prisma.user.findMany({
      where: { id: { not: excludeId } },
      select: {
        id: true,
        userId: true,
        role: true,
        shipId: true,
        createdAt: true,
        ship: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return users;
  }

  async resetPassword(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    const plainPassword = generatePassword();
    const passwordHash = await bcrypt.hash(plainPassword, 10);
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash },
    });
    return { userId: user.userId, password: plainPassword };
  }

  async remove(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    await this.prisma.user.delete({ where: { id } });
  }
}
