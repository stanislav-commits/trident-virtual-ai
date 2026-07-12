import {
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
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { UserRole } from '../../common/enums/user-role.enum';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { BulkDeleteDocumentsDto } from './dto/delete-documents.dto';
import { CreatePublicationCatalogDto } from './dto/create-publication-catalog.dto';
import { ListDocumentsQueryDto } from './dto/list-documents-query.dto';
import { ReparseDocumentDto } from './dto/reparse-document.dto';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { UpdateDocumentClassificationDto } from './dto/update-document-classification.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { DocumentsService } from './documents.service';
import { PublicationCatalogService } from './publications/publication-catalog.service';
import { UploadedDocumentFile } from './ingestion/documents-upload.types';

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly publicationCatalogService: PublicationCatalogService,
  ) {}

  @Post()
  @UseInterceptors(FileInterceptor('file'))
  upload(
    @Body() body: UploadDocumentDto,
    @UploadedFile() file: UploadedDocumentFile,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.upload(body, file, user);
  }

  @Get()
  list(
    @Query() query: ListDocumentsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.list(query, user);
  }

  // Fleet-wide Publications (platform scope) — admin-only, no ship selection.
  // Declared before the `:id` routes so "publications" isn't captured as an id.
  @Post('publications')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  uploadPublication(
    @Body() body: UploadDocumentDto,
    @UploadedFile() file: UploadedDocumentFile,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.uploadPublication(body, file, user);
  }

  @Get('publications')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  listPublications(
    @Query() query: ListDocumentsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.listPublications(query, user);
  }

  // Publications Library catalog (fleet-wide list of expected publications).
  @Get('publications/catalog')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  listPublicationCatalog() {
    return this.publicationCatalogService.list();
  }

  @Post('publications/catalog')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  createPublicationCatalogItem(@Body() body: CreatePublicationCatalogDto) {
    return this.publicationCatalogService.create(body);
  }

  @Post('publications/catalog/:id/file')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  attachPublicationFile(
    @Param('id') id: string,
    @UploadedFile() file: UploadedDocumentFile,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.publicationCatalogService.attachFile(id, file, user);
  }

  @Delete('publications/catalog/:id/file')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  detachPublicationFile(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.publicationCatalogService.detachFile(id, user);
  }

  @Post('bulk-delete')
  bulkDelete(
    @Body() body: BulkDeleteDocumentsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.bulkDelete(body, user);
  }

  @Get(':id/file')
  async getFile(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ) {
    const file = await this.documentsService.getFile(id, user);

    response.setHeader('Content-Type', file.contentType);
    response.setHeader(
      'Content-Disposition',
      this.buildInlineContentDisposition(file.fileName),
    );
    response.setHeader('Content-Length', String(file.buffer.length));
    response.send(file.buffer);
  }

  @Get(':id/extracted')
  @Roles(UserRole.ADMIN)
  getExtracted(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.documentsService.getExtractedMarkdown(id, user);
  }

  @Post(':id/extracted/rerun')
  @Roles(UserRole.ADMIN)
  rerunExtraction(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.rerunExtraction(id, user);
  }

  @Get(':id')
  getById(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.documentsService.getById(id, user);
  }

  /** Rename (KB edit modal). Also renames the RAGFlow doc, best-effort. */
  @Patch(':id/name')
  rename(
    @Param('id') id: string,
    @Body() body: { name?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.rename(id, body.name ?? '', user);
  }

  /** Assets this document is pinned/auto-matched to (KB edit modal). */
  @Get(':id/asset-links')
  listAssetLinks(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.listAssetLinks(id, user);
  }

  @Patch(':id/classification')
  updateClassification(
    @Param('id') id: string,
    @Body() body: UpdateDocumentClassificationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.updateClassification(id, body, user);
  }

  @Post(':id/reparse')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  reparse(
    @Param('id') id: string,
    @Body() body: ReparseDocumentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.reparse(id, user, body ?? {});
  }

  @Post(':id/status-sync')
  syncStatus(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.documentsService.syncStatus(id, user);
  }

  @Post(':id/ingestion-retry')
  retryIngestion(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.documentsService.retryIngestion(id, user);
  }

  @Delete(':id')
  delete(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.documentsService.delete(id, user);
  }

  @Post('search')
  search(@Body() body: SearchDocumentsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.documentsService.search({
      ...body,
      shipId: user.role === UserRole.ADMIN ? body.shipId : user.shipId ?? undefined,
    });
  }

  private buildInlineContentDisposition(fileName: string): string {
    const fallbackFileName =
      fileName
        .replace(/[^\x20-\x7E]+/g, '_')
        .replace(/["\\]/g, '_')
        .trim() || 'document';

    return `inline; filename="${fallbackFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  }
}
