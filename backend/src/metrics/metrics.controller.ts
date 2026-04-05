import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CreateMetricDefinitionDto } from './dto/create-metric-definition.dto';
import { ReplaceTagLinksDto } from '../tags/dto/replace-tag-links.dto';
import { UpdateMetricDefinitionDto } from './dto/update-metric-definition.dto';
import { MetricsService } from './metrics.service';

@Controller('metrics')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class MetricsController {
  constructor(private readonly metricsService: MetricsService) {}

  @Post('sync')
  syncFromInflux() {
    return this.metricsService.syncCatalogFromInflux();
  }

  @Get('values')
  async getLatestValues(@Query('keys') keysParam?: string) {
    const keys =
      keysParam
        ?.split(',')
        .map((k) => k.trim())
        .filter(Boolean) ?? [];
    return this.metricsService.getLatestValues(keys);
  }

  @Get('ship/:shipId/telemetry')
  async getShipTelemetry(@Param('shipId') shipId: string) {
    return this.metricsService.getShipTelemetry(shipId);
  }

  @Get()
  findAll() {
    return this.metricsService.findAll();
  }

  @Get(':key')
  findOne(@Param('key') key: string) {
    return this.metricsService.findOne(key);
  }

  @Get(':key/tags')
  listTags(@Param('key') key: string) {
    return this.metricsService.listTags(key);
  }

  @Post()
  create(@Body() dto: CreateMetricDefinitionDto) {
    return this.metricsService.create(dto);
  }

  @Patch(':key')
  update(@Param('key') key: string, @Body() dto: UpdateMetricDefinitionDto) {
    return this.metricsService.update(key, dto);
  }

  @Put(':key/tags')
  replaceTags(@Param('key') key: string, @Body() dto: ReplaceTagLinksDto) {
    return this.metricsService.replaceTags(
      key,
      dto.tagId === undefined || dto.tagId === null ? dto.tagIds : [dto.tagId],
    );
  }

  @Delete(':key')
  remove(@Param('key') key: string) {
    return this.metricsService.remove(key);
  }
}
