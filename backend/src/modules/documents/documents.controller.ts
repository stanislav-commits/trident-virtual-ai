import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
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
import { UpdatePublicationCatalogDto } from './dto/update-publication-catalog.dto';
import {
  CreatePublicationNodeDto,
  MovePublicationNodeDto,
  UpdatePublicationNodeDto,
} from './dto/publication-node.dto';
import {
  ImportNode,
  PublicationTreeService,
} from './publications/publication-tree.service';
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
    private readonly publicationTreeService: PublicationTreeService,
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

  // ── Publications library tree ──────────────────────────────────────────

  @Get('publications/tree/rail')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  publicationRail() {
    return this.publicationTreeService.rail();
  }

  /** Create a publication (rail shelf), optionally with its first category. */
  /** The queue of rows whose extracted text the quality score doubts. */
  @Get('publications/tree/review')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  publicationReviewQueue(
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('publication') publication?: string,
  ) {
    return this.publicationTreeService.reviewQueue(
      Math.min(Number(limit) || 25, 100),
      Math.max(Number(offset) || 0, 0),
      publication || undefined,
    );
  }

  @Post('publications/tree/nodes/:id/accept-text')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  acceptPublicationText(@Param('id') id: string) {
    return this.publicationTreeService.acceptText(id);
  }

  @Get('publications/tree/jurisdictions')
  publicationJurisdictions() {
    return this.publicationTreeService.jurisdictions();
  }

  @Post('publications/tree/shelves')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  createPublicationShelf(
    @Body()
    body: { publication?: string; category?: string | null; jurisdiction?: string | null },
  ) {
    return this.publicationTreeService.createShelf({
      publication: body?.publication ?? '',
      category: body?.category ?? null,
      jurisdiction: body?.jurisdiction ?? null,
    });
  }

  /** What a delete would take with it — shown before it is confirmed. */
  @Get('publications/tree/shelves/contents')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  publicationShelfContents(
    @Query('publication') publication: string,
    @Query('category') category?: string,
  ) {
    return this.publicationTreeService.shelfContents(publication, category || undefined);
  }

  /** Without `category`, the publication itself is renamed. */
  @Patch('publications/tree/shelves')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  renamePublicationShelf(
    @Body() body: { publication?: string; category?: string | null; name?: string },
  ) {
    return this.publicationTreeService.renameShelf({
      publication: body?.publication ?? '',
      category: body?.category ?? null,
      name: body?.name ?? '',
    });
  }

  /** Without `category`, the whole publication goes. */
  @Delete('publications/tree/shelves')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removePublicationShelf(
    @CurrentUser() user: AuthenticatedUser,
    @Query('publication') publication: string,
    @Query('category') category?: string,
    @Query('withContents') withContents?: string,
  ) {
    if (!category) {
      await this.publicationTreeService.removePublication(publication, user);
      return;
    }
    await this.publicationTreeService.removeShelf(
      publication,
      category,
      user,
      withContents === 'true',
    );
  }

  @Get('publications/tree/roots')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  publicationRoots(
    @Query('category') category: string,
    @Query('type') type?: string,
  ) {
    return this.publicationTreeService.roots(category, type || undefined);
  }

  @Get('publications/tree/search')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  publicationSearch(@Query('q') q: string) {
    return this.publicationTreeService.search(q ?? '');
  }

  /** Preview: the node's own text, or a digest of what is under it. */
  @Get('publications/tree/nodes/:id/content')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  publicationNodeContent(@Param('id') id: string) {
    return this.publicationTreeService.content(id);
  }

  @Get('publications/tree/nodes/:id/children')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  publicationChildren(@Param('id') id: string) {
    return this.publicationTreeService.children(id);
  }

  @Post('publications/tree/nodes')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  createPublicationNode(@Body() body: CreatePublicationNodeDto) {
    return this.publicationTreeService.createNode(body);
  }

  @Patch('publications/tree/nodes/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  updatePublicationNode(
    @Param('id') id: string,
    @Body() body: UpdatePublicationNodeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.publicationTreeService.updateNode(id, body, user);
  }

  @Post('publications/tree/nodes/:id/move')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  movePublicationNode(
    @Param('id') id: string,
    @Body() body: MovePublicationNodeDto,
  ) {
    return this.publicationTreeService.moveNode(id, body);
  }

  @Delete('publications/tree/nodes/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removePublicationNode(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.publicationTreeService.removeNode(id, user);
  }

  /** Attach the file this node holds (PDF keeps its original for viewing). */
  @Post('publications/tree/nodes/:id/content')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  attachPublicationNodeContent(
    @Param('id') id: string,
    @UploadedFile() file: UploadedDocumentFile,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.publicationTreeService.attachContent(id, file, user);
  }

  /** Scans still missing their original file — the loader fills these. */
  /** Which source files actually reached the tree — the importer's audit. */
  @Get('publications/tree/source-refs')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  publicationSourceRefs(@Query('category') category: string) {
    return this.publicationTreeService.sourceRefs(category);
  }

  @Get('publications/tree/pending-originals')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  publicationPendingOriginals(@Query('limit') limit?: string) {
    return this.publicationTreeService.pendingOriginals(
      limit ? parseInt(limit, 10) || 500 : 500,
    );
  }

  /** Re-transcribe a scan (or every scan under a branch) with vision. */
  @Post('publications/tree/nodes/:id/parse')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  parsePublicationNode(@Param('id') id: string) {
    return this.publicationTreeService.parse(id);
  }

  /** Collect finished vision output into the nodes waiting on it. */
  @Post('publications/tree/collect-parsed')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  collectParsedPublications(@CurrentUser() user: AuthenticatedUser) {
    return this.publicationTreeService
      .collectParsed(user)
      .then((collected) => ({ collected }));
  }

  /** Bulk import of a subtree (the Regs4Ships library load). */
  @Post('publications/tree/import')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  importPublicationSubtree(
    @Body()
    body: {
      parentId?: string | null;
      category?: string;
      nodeType?: string;
      jurisdiction?: string | null;
      nodes?: ImportNode[];
    },
  ) {
    return this.publicationTreeService.importSubtree({
      parentId: body?.parentId ?? null,
      category: body?.category,
      nodeType: body?.nodeType,
      jurisdiction: body?.jurisdiction ?? null,
      nodes: body?.nodes ?? [],
    });
  }

  /** Default AI-document boundary for a freshly imported publication. */
  @Post('publications/tree/nodes/:id/auto-mark')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  autoMarkPublicationAiDocuments(@Param('id') id: string) {
    return this.publicationTreeService
      .autoMarkAiDocuments(id)
      .then((marked) => ({ marked }));
  }

  /** Mark/unmark the node the AI index holds as one document. */
  @Post('publications/tree/nodes/:id/ai-document')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  setPublicationAiDocument(
    @Param('id') id: string,
    @Body() body: { enabled?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.publicationTreeService.setAiDocument(
      id,
      body?.enabled !== false,
      user,
    );
  }

  /** "Add article": append one section to a merged markdown publication. */
  @Post('publications/catalog/:id/append')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('file'))
  appendPublicationSection(
    @Param('id') id: string,
    @Body() body: { heading?: string },
    @UploadedFile() file: UploadedDocumentFile,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.publicationCatalogService.appendSection(
      id,
      body?.heading ?? '',
      file,
      user,
    );
  }

  @Patch('publications/catalog/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  updatePublicationCatalogItem(
    @Param('id') id: string,
    @Body() body: UpdatePublicationCatalogDto,
  ) {
    return this.publicationCatalogService.update(id, body);
  }

  @Delete('publications/catalog/:id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  removePublicationCatalogItem(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.publicationCatalogService.remove(id, user);
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

  /**
   * SMS↔forms links (KB edit modal): for a procedure/circular, the forms it
   * references (code match + manual); for a form, the procedures/circulars
   * that reference it back. Same endpoint works from either side.
   */
  @Get(':id/form-links')
  listFormLinks(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.formLinksFor(id, user);
  }

  /** Pin a form↔procedure/circular link the code scan missed (or restore
   *  one previously suppressed). Admin-only — this is a correction to what
   *  the AI code-scan found, not a routine read. */
  @Post(':id/form-links')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  addFormLink(
    @Param('id') id: string,
    @Body() body: { otherDocumentId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.addFormLink(
      id,
      body.otherDocumentId ?? '',
      user,
    );
  }

  /** Remove a form link. If it came from the code scan, this records a
   *  suppression so the wrong match doesn't resurface (in the modal or in
   *  chat citations) — it does not just hide it client-side. */
  @Delete(':id/form-links/:otherId')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  removeFormLink(
    @Param('id') id: string,
    @Param('otherId') otherId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.documentsService.removeFormLink(id, otherId, user);
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
