import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  create(@Body() dto: CreateUserDto) {
    return this.usersService.create(dto.role, dto.shipId, dto.name);
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser) {
    return this.usersService.findAll(user.id);
  }

  @Patch(':id/reset-password')
  resetPassword(@Param('id') id: string) {
    return this.usersService.resetPassword(id);
  }

  @Patch(':id/name')
  updateName(@Param('id') id: string, @Body() body: { name?: string }) {
    return this.usersService.updateName(id, body.name);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.usersService.remove(id);
  }
}
