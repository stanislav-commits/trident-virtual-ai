import { compare } from 'bcryptjs';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UsersService } from '../../modules/users/users.service';
import { AuthenticatedUser, JwtPayload } from './auth.types';

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
  ) {}

  async login(userId: string, password: string) {
    const user = await this.usersService.findByUserId(userId);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const isValid = await compare(password, user.passwordHash);

    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const authUser = this.usersService.toAuthUser(user);
    const payload: JwtPayload = {
      sub: authUser.id,
      userId: authUser.userId,
      role: authUser.role,
      shipId: authUser.shipId,
    };

    return {
      access_token: await this.jwtService.signAsync(payload),
      user: authUser,
    };
  }

  me(user: AuthenticatedUser) {
    return { user };
  }
}
