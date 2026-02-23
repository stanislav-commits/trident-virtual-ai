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
import { CreateShipDto } from './dto/create-ship.dto';
import { UpdateShipDto } from './dto/update-ship.dto';
import { ShipsService } from './ships.service';

@Controller('ships')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class ShipsController {
  constructor(private readonly shipsService: ShipsService) {}

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
