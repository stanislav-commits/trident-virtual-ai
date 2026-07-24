import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '../../common/enums/user-role.enum';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserNameDto } from './dto/update-user-name.dto';
import { UpdateUserShipDto } from './dto/update-user-ship.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.me(user);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  list() {
    return this.usersService.list();
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  create(@Body() body: CreateUserDto) {
    // The crew roster is the single source of truth for vessel people:
    // vessel (role=user) logins are provisioned ONLY from the Crew tab
    // (crew/:id/login), which links the account to its roster row. Creating
    // one here would bypass that link — the account would be invisible in
    // the roster and impossible to manage from it (observed on prod
    // 2026-07-24). This endpoint keeps creating platform admins only;
    // crew.createLogin calls the service directly, not this route.
    if (body.role !== UserRole.ADMIN) {
      throw new BadRequestException(
        'Vessel logins are created from the Crew tab (roster → key icon), not here.',
      );
    }
    return this.usersService.create(body);
  }

  @Patch(':id/name')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateName(@Param('id') id: string, @Body() body: UpdateUserNameDto) {
    return this.usersService.updateName(id, body);
  }

  @Patch(':id/ship')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  updateShip(@Param('id') id: string, @Body() body: UpdateUserShipDto) {
    return this.usersService.updateShip(id, body);
  }

  @Patch(':id/reset-password')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  resetPassword(@Param('id') id: string) {
    return this.usersService.resetPassword(id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  delete(@Param('id') id: string) {
    return this.usersService.delete(id);
  }
}
