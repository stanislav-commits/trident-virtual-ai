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
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import { AssetsService } from './assets.service';
import { CommitImportDto } from './dto/commit-import.dto';
import { CreateAssetDto } from './dto/create-asset.dto';
import { QueryAssetsDto } from './dto/query-assets.dto';
import {
  CompleteServiceRuleDto,
  CreateServiceRuleDto,
  UpdateServiceRuleDto,
} from './dto/service-rule.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';

@Controller('ships/:shipId/assets')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Get()
  list(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Query() query: QueryAssetsDto,
  ) {
    return this.assetsService.list(shipId, query);
  }

  // NOTE: must be declared BEFORE @Get(':assetId') — otherwise "export-xlsx"
  // is captured by the :assetId param and fails the UUID pipe.
  @Get('export-xlsx')
  @Roles(UserRole.ADMIN)
  async exportXlsx(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.assetsService.exportXlsx(shipId);
    res.set({
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new StreamableFile(buffer);
  }

  @Get(':assetId')
  getOne(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.assetsService.getOne(shipId, assetId);
  }

  @Get(':assetId/related')
  getRelated(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.assetsService.getRelated(shipId, assetId);
  }

  @Post()
  @Roles(UserRole.ADMIN)
  create(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Body() body: CreateAssetDto,
  ) {
    return this.assetsService.create(shipId, body);
  }

  @Patch(':assetId')
  @Roles(UserRole.ADMIN)
  update(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() body: UpdateAssetDto,
  ) {
    return this.assetsService.update(shipId, assetId, body);
  }

  @Delete()
  @Roles(UserRole.ADMIN)
  clearAll(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assetsService.clearAll(shipId, user.id);
  }

  @Delete(':assetId')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ): Promise<void> {
    await this.assetsService.remove(shipId, assetId);
  }

  @Post('import-xlsx')
  @Roles(UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  importXlsx(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.assetsService.importFromXlsx(shipId, file.buffer);
  }

  @Post('import-xlsx/preview')
  @Roles(UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  previewImport(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.assetsService.previewImportFromXlsx(shipId, file.buffer);
  }

  @Post('import-xlsx/commit')
  @Roles(UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  commitImport(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() body: CommitImportDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.assetsService.commitImportFromXlsx(
      shipId,
      file.buffer,
      body,
      user.id,
    );
  }

  @Post(':assetId/documents/:documentId')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async linkDocument(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.assetsService.linkDocument(
      shipId, assetId, documentId, user.id,
    );
  }

  @Delete(':assetId/documents/:documentId')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async unlinkDocument(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ): Promise<void> {
    await this.assetsService.unlinkDocument(shipId, assetId, documentId);
  }

  // ── Service rules (PMS core) ──

  @Get(':assetId/service-rules')
  listServiceRules(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.assetsService.listServiceRules(shipId, assetId);
  }

  @Post(':assetId/service-rules')
  @Roles(UserRole.ADMIN)
  createServiceRule(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
    @Body() body: CreateServiceRuleDto,
  ) {
    return this.assetsService.createServiceRule(shipId, assetId, body);
  }

  @Patch('service-rules/:ruleId')
  @Roles(UserRole.ADMIN)
  updateServiceRule(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() body: UpdateServiceRuleDto,
  ) {
    return this.assetsService.updateServiceRule(shipId, ruleId, body);
  }

  @Post('service-rules/:ruleId/complete')
  @Roles(UserRole.ADMIN)
  completeServiceRule(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
    @Body() body: CompleteServiceRuleDto,
  ) {
    return this.assetsService.completeServiceRule(shipId, ruleId, body);
  }

  @Delete('service-rules/:ruleId')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteServiceRule(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('ruleId', ParseUUIDPipe) ruleId: string,
  ): Promise<void> {
    await this.assetsService.deleteServiceRule(shipId, ruleId);
  }
}
