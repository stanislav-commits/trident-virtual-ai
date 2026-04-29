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
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { BulkDeleteDocumentsDto } from './dto/delete-documents.dto';
import { ListDocumentsQueryDto } from './dto/list-documents-query.dto';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { UpdateDocumentClassificationDto } from './dto/update-document-classification.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { DocumentsService } from './documents.service';
import { UploadedDocumentFile } from './documents-upload.types';

@Controller('documents')
@UseGuards(JwtAuthGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

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

  @Get(':id')
  getById(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.documentsService.getById(id, user);
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
  reparse(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.documentsService.reparse(id, user);
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
