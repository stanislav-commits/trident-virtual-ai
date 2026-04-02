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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BulkRemoveTagsDto } from './dto/bulk-remove-tags.dto';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { TagsService } from './tags.service';

@Controller('tags')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class TagsController {
  constructor(private readonly tagsService: TagsService) {}

  private parsePositiveInt(value: string | undefined, fallback?: number) {
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return parsed;
  }

  private parseSearchQuery(value: string | undefined) {
    const normalized = value?.trim();
    return normalized ? normalized : undefined;
  }

  @Get()
  findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('subcategory') subcategory?: string,
  ) {
    return this.tagsService.findAll({
      page: this.parsePositiveInt(page),
      pageSize: this.parsePositiveInt(pageSize),
      search: this.parseSearchQuery(search),
      category,
      subcategory,
    });
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.tagsService.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateTagDto) {
    return this.tagsService.create(dto);
  }

  @Post('bulk-delete')
  bulkRemove(@Body() dto: BulkRemoveTagsDto) {
    return this.tagsService.bulkRemove(dto);
  }

  @Post('import')
  @UseInterceptors(FileInterceptor('file'))
  import(
    @UploadedFile()
    file:
      | {
          buffer?: Buffer;
          originalname?: string;
          mimetype?: string;
        }
      | undefined,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('JSON file is required');
    }

    return this.tagsService.importTaxonomy({
      buffer: file.buffer,
      originalname: file.originalname,
      mimetype: file.mimetype,
    });
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTagDto) {
    return this.tagsService.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.tagsService.remove(id);
  }
}
