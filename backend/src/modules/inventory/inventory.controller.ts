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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserRole } from '../../common/enums/user-role.enum';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import {
  InventoryService,
  UpsertInventoryInput,
  InventoryDraft,
} from './inventory.service';
import {
  InventoryImportService,
  InventoryImportDraft,
} from './inventory-import.service';

interface UploadedImportFile {
  buffer?: Buffer;
  originalname?: string;
  mimetype?: string;
}

@Controller('ships/:shipId/inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(
    private readonly inventoryService: InventoryService,
    private readonly inventoryImportService: InventoryImportService,
  ) {}

  @Get()
  list(@Param('shipId', ParseUUIDPipe) shipId: string) {
    return this.inventoryService.list(shipId);
  }

  @Get('assets/:assetId')
  listForAsset(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.inventoryService.listForAsset(shipId, assetId);
  }

  @Get('tasks/:taskId')
  listForTask(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.inventoryService.listForTask(shipId, taskId);
  }

  /** Set the full set of parts linked to a task (from the task's parts panel). */
  @Post('tasks/:taskId/parts')
  @Roles(UserRole.ADMIN)
  setTaskParts(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: { itemIds: string[] },
  ) {
    return this.inventoryService.setLinksForTask(
      shipId,
      taskId,
      body?.itemIds ?? [],
    );
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Body() body: UpsertInventoryInput,
  ) {
    return this.inventoryService.create(shipId, body);
  }

  @Patch(':id')
  @Roles(UserRole.ADMIN)
  update(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: Partial<UpsertInventoryInput>,
  ) {
    return this.inventoryService.update(shipId, id, body);
  }

  @Delete(':id')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.inventoryService.remove(shipId, id);
  }

  @Post('commit')
  @Roles(UserRole.ADMIN)
  commit(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Body() body: { drafts: InventoryDraft[] },
  ) {
    return this.inventoryService.createMany(shipId, body?.drafts ?? []);
  }

  // ── Stock-file import (AI-reformatted → reviewed → idempotent upsert) ──

  @Post('import/preview')
  @Roles(UserRole.ADMIN)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 16 * 1024 * 1024 } }),
  )
  importPreview(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @UploadedFile() file: UploadedImportFile | undefined,
    @Body() body: { text?: string },
  ) {
    return this.inventoryImportService.preview(shipId, file ?? null, body?.text);
  }

  @Post('import/commit')
  @Roles(UserRole.ADMIN)
  importCommit(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Body() body: { drafts: InventoryImportDraft[] },
  ) {
    return this.inventoryImportService.commit(shipId, body?.drafts ?? []);
  }

  @Post('assets/:assetId/suggest')
  @Roles(UserRole.ADMIN)
  suggest(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() body: { text: string },
  ) {
    return this.inventoryService.suggestFromManual(shipId, assetId, body?.text ?? '');
  }
}
