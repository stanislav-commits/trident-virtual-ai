import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
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
import { BulkRemoveManualsDto } from './dto/bulk-remove-manuals.dto';
import { UpdateManualDto } from './dto/update-manual.dto';
import { UpdateShipDto } from './dto/update-ship.dto';
import {
  DEFAULT_SHIP_MANUAL_CATEGORY,
  parseShipManualCategory,
  type ShipManualCategory,
} from './manual-category';
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

  private parsePositiveInt(value: string | undefined, fallback?: number) {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return parsed;
  }

  private parseManualCategory(
    value: string | undefined,
    fallback?: ShipManualCategory,
  ) {
    if (!value?.trim()) return fallback;
    const category = parseShipManualCategory(value);
    if (!category) {
      throw new BadRequestException('Invalid knowledge base category');
    }
    return category;
  }

  @Get('metric-definitions')
  getMetricDefinitions() {
    return this.shipsService.getMetricDefinitions();
  }

  @Get('organizations')
  listOrganizations() {
    return this.shipsService.listOrganizations();
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
  findAllManualsWithStatus(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('category') category?: string,
  ) {
    return this.manualsService.findAllWithStatus(
      id,
      this.parsePositiveInt(page),
      this.parsePositiveInt(pageSize),
      this.parseManualCategory(category),
    );
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

  @Post(':id/manuals/bulk-delete')
  bulkRemoveManuals(
    @Param('id') id: string,
    @Body() dto: BulkRemoveManualsDto,
  ) {
    return this.manualsService.bulkRemove(id, dto);
  }

  @Get(':id/manuals')
  findAllManuals(
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('category') category?: string,
  ) {
    return this.manualsService.findAll(
      id,
      this.parsePositiveInt(page),
      this.parsePositiveInt(pageSize),
      this.parseManualCategory(category),
    );
  }

  @Post(':id/manuals')
  @UseInterceptors(FileInterceptor('file'))
  createManual(
    @Param('id') id: string,
    @UploadedFile()
    file: { buffer?: Buffer; originalname?: string } | undefined,
    @Body('category') category?: string,
  ) {
    if (!file?.buffer) throw new BadRequestException('File is required');
    return this.manualsService.create(id, {
      buffer: file.buffer,
      originalname: file.originalname,
    }, {
      category: this.parseManualCategory(
        category,
        DEFAULT_SHIP_MANUAL_CATEGORY,
      ),
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
