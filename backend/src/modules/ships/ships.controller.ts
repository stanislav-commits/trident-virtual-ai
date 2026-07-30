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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { UserRole } from '../../common/enums/user-role.enum';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { CreateShipDto } from './dto/create-ship.dto';
import { UpdateShipDto } from './dto/update-ship.dto';
import { ShipOrganizationsService } from './ship-organizations.service';
import { ShipsCommandService } from './ships-command.service';
import { ShipPhotoService, type ShipPhotoFile } from './ship-photo.service';
import { ShipsQueryService } from './ships-query.service';

@Controller('ships')
@UseGuards(JwtAuthGuard)
export class ShipsController {
  constructor(
    private readonly shipsQueryService: ShipsQueryService,
    private readonly shipsCommandService: ShipsCommandService,
    private readonly shipOrganizationsService: ShipOrganizationsService,
    private readonly shipPhotoService: ShipPhotoService,
  ) {}

  // ── Vessel photo (Overview) ──

  @Post(':id/photo')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }),
  )
  @HttpCode(HttpStatus.NO_CONTENT)
  uploadPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: ShipPhotoFile | undefined,
  ): Promise<void> {
    return this.shipPhotoService.upload(id, file);
  }

  /**
   * Readable by any signed-in user — it is the vessel's own picture, shown in the
   * app shell — but never public: the bytes come through the API with the bearer
   * token, not from a guessable storage URL.
   */
  @Get(':id/photo')
  async getPhoto(
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, mime } = await this.shipPhotoService.read(id);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(buffer);
  }

  @Delete(':id/photo')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  deletePhoto(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.shipPhotoService.remove(id);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.shipsQueryService.listForUser(user);
  }

  @Get('organizations')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  listOrganizations() {
    return this.shipOrganizationsService.list();
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.shipsQueryService.getAccessibleShip(id, user);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  create(@Body() body: CreateShipDto) {
    return this.shipsCommandService.create(body);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() body: UpdateShipDto) {
    return this.shipsCommandService.update(id, body);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  async remove(@Param('id') id: string) {
    await this.shipsCommandService.remove(id);
  }
}
