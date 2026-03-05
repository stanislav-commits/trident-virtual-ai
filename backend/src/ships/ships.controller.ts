import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateShipDto } from './dto/create-ship.dto';
import { UpdateManualDto } from './dto/update-manual.dto';
import { UpdateShipDto } from './dto/update-ship.dto';
import { ManualsService } from './manuals.service';
import { ShipsService } from './ships.service';

@Controller('ships')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class ShipsController {
  constructor(
    private readonly shipsService: ShipsService,
    private readonly manualsService: ManualsService,
  ) {}

  @Get('metric-definitions')
  getMetricDefinitions() {
    return this.shipsService.getMetricDefinitions();
  }

  @Post()
  create(@Body() dto: CreateShipDto) {
    return this.shipsService.create(dto);
  }

  @Get()
  findAll() {
    return this.shipsService.findAll();
  }

  @Get(':id/manuals/status')
  findAllManualsWithStatus(@Param('id') id: string) {
    return this.manualsService.findAllWithStatus(id);
  }

  @Get(':id/manuals/:manualId/download')
  async downloadManual(
    @Param('id') id: string,
    @Param('manualId') manualId: string,
    @Res() res: Response,
  ) {
    const { buffer, filename, contentType } =
      await this.manualsService.download(id, manualId);
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${filename.replace(/"/g, '_')}"`,
    );
    res.send(buffer);
  }

  @Get(':id/manuals/:manualId')
  findOneManual(@Param('id') id: string, @Param('manualId') manualId: string) {
    return this.manualsService.findOne(id, manualId);
  }

  @Patch(':id/manuals/:manualId')
  updateManual(
    @Param('id') id: string,
    @Param('manualId') manualId: string,
    @Body() dto: UpdateManualDto,
  ) {
    return this.manualsService.update(id, manualId, dto);
  }

  @Delete(':id/manuals/:manualId')
  removeManual(@Param('id') id: string, @Param('manualId') manualId: string) {
    return this.manualsService.remove(id, manualId);
  }

  @Get(':id/manuals')
  findAllManuals(@Param('id') id: string) {
    return this.manualsService.findAll(id);
  }

  @Post(':id/manuals')
  @UseInterceptors(FileInterceptor('file'))
  createManual(
    @Param('id') id: string,
    @UploadedFile()
    file: { buffer?: Buffer; originalname?: string } | undefined,
  ) {
    if (!file?.buffer) throw new BadRequestException('File is required');
    return this.manualsService.create(id, {
      buffer: file.buffer,
      originalname: file.originalname,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.shipsService.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateShipDto) {
    return this.shipsService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.shipsService.remove(id);
  }
}
