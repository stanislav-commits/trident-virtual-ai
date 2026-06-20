import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '../../common/enums/user-role.enum';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import { CrewService, UpsertCrewInput } from './crew.service';

@Controller('ships/:shipId/crew')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CrewController {
  constructor(private readonly crewService: CrewService) {}

  @Get('catalog')
  catalog() {
    return this.crewService.catalog();
  }

  @Get()
  list(@Param('shipId', ParseUUIDPipe) shipId: string) {
    return this.crewService.list(shipId);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Body() body: UpsertCrewInput,
  ) {
    return this.crewService.create(shipId, body);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  update(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Partial<UpsertCrewInput>,
  ) {
    return this.crewService.update(shipId, id, body);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.crewService.remove(shipId, id);
  }

  // ── login provisioning ──

  @Post(':id/login')
  @Roles(UserRole.ADMIN)
  createLogin(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.crewService.createLogin(shipId, id);
  }

  @Patch(':id/login/reset')
  @Roles(UserRole.ADMIN)
  resetLogin(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.crewService.resetLogin(shipId, id);
  }

  @Delete(':id/login')
  @Roles(UserRole.ADMIN)
  revokeLogin(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.crewService.revokeLogin(shipId, id);
  }
}
