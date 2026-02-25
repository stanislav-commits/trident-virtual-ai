import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import type { Role } from '@prisma/client';

export type JwtPayload = {
  sub: string;
  userId: string;
  role: Role;
  shipId?: string | null;
};

export type AuthUser = {
  id: string;
  userId: string;
  role: Role;
  shipId: string | null;
};

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async validateUser(
    userId: string,
    password: string,
  ): Promise<AuthUser | null> {
    const user = await this.prisma.user.findUnique({
      where: { userId },
    });
    if (!user) return null;
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return null;
    return {
      id: user.id,
      userId: user.userId,
      role: user.role,
      shipId: user.shipId,
    };
  }

  login(user: AuthUser) {
    const payload: JwtPayload = {
      sub: user.id,
      userId: user.userId,
      role: user.role,
      shipId: user.shipId ?? undefined,
    };
    return {
      access_token: this.jwtService.sign(payload),
      user,
    };
  }
}
