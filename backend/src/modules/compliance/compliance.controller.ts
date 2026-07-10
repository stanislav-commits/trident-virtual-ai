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
  Res,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Response } from 'express';
import { UserRole } from '../../common/enums/user-role.enum';
import { CurrentUser } from '../../core/auth/decorators/current-user.decorator';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { Roles } from '../../core/auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../core/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../core/auth/guards/roles.guard';
import {
  ComplianceService,
  UpsertComplianceDocInput,
} from './compliance.service';
import {
  ComplianceExtractionService,
  CommitProposal,
} from './compliance-extraction.service';

interface UploadedComplianceFile {
  buffer?: Buffer;
  originalname?: string;
  mimetype?: string;
}

@Controller('ships/:shipId/compliance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ComplianceController {
  constructor(
    private readonly complianceService: ComplianceService,
    private readonly extractionService: ComplianceExtractionService,
  ) {}

  /** Batch AI: read PDFs (or {items:[{filename,text}]}) → proposals, NO save. */
  @Post('ingest/preview')
  @Roles(UserRole.ADMIN)
  @UseInterceptors(
    FilesInterceptor('files', 30, { limits: { fileSize: 16 * 1024 * 1024 } }),
  )
  ingestPreview(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @UploadedFiles() files: UploadedComplianceFile[] | undefined,
    @Body() body: { items?: Array<{ filename: string; text: string }> },
  ) {
    const items =
      files && files.length
        ? files.map((f) => ({
            filename: f.originalname ?? 'document.pdf',
            buffer: f.buffer,
          }))
        : (body?.items ?? []);
    return this.extractionService.preview(shipId, items);
  }

  /**
   * Persist the operator-reviewed proposals as confirmed records. Sent as
   * multipart so the original files ride along and get stored for preview
   * (`proposals` is a JSON string field; each proposal's `filename` matches an
   * uploaded file). Still accepts a plain JSON array for back-compat.
   */
  @Post('ingest/commit')
  @Roles(UserRole.ADMIN)
  @UseInterceptors(
    FilesInterceptor('files', 30, { limits: { fileSize: 16 * 1024 * 1024 } }),
  )
  ingestCommit(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @UploadedFiles() files: UploadedComplianceFile[] | undefined,
    @Body() body: { proposals: CommitProposal[] | string },
  ) {
    const proposals: CommitProposal[] =
      typeof body?.proposals === 'string'
        ? JSON.parse(body.proposals)
        : (body?.proposals ?? []);
    const items =
      files?.map((f) => ({
        filename: f.originalname ?? 'document.pdf',
        buffer: f.buffer,
      })) ?? [];
    return this.extractionService.commit(shipId, proposals, items);
  }

  /**
   * "Add document" on a compliance row: the type is already chosen, so extract
   * the archetype's fields from the already-uploaded document (skip category
   * detection) and return a PROPOSAL for the operator to review + confirm.
   * Nothing is saved here — the frontend persists via POST docs after review.
   */
  @Post('types/:typeId/extract')
  @Roles(UserRole.ADMIN)
  extractForType(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @Body() body: { documentId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.extractionService.extractForType(
      shipId,
      typeId,
      body.documentId,
      user,
    );
  }

  /**
   * One-off admin action: transcribe + store full text for all records that
   * have a file but no text yet (so pre-existing certs become chat-answerable).
   */
  @Post('backfill-text')
  @Roles(UserRole.ADMIN)
  backfillText(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.extractionService.backfillTexts(shipId, user);
  }

  /** Stream a compliance record's original file inline (for preview/download). */
  @Get('docs/:docId/file')
  async getDocFile(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ) {
    const file = await this.complianceService.getDocFile(shipId, docId, user);
    response.setHeader('Content-Type', file.contentType);
    response.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(file.fileName)}"`,
    );
    response.setHeader('Content-Length', String(file.buffer.length));
    response.send(file.buffer);
  }

  @Post('instantiate')
  @Roles(UserRole.ADMIN)
  instantiate(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Body()
    body: {
      gtBucket?: string;
      grossTonnage?: number;
      lengthM?: number;
      operationType?: string;
      flagRegistry?: string | null;
    },
  ) {
    return this.complianceService.instantiateForShip(shipId, body);
  }

  @Get('overview')
  overview(@Param('shipId', ParseUUIDPipe) shipId: string) {
    return this.complianceService.overview(shipId);
  }

  @Get('archetypes')
  archetypes() {
    return this.complianceService.archetypeSchema();
  }

  @Get('assets/:assetId/docs')
  listForAsset(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('assetId', ParseUUIDPipe) assetId: string,
  ) {
    return this.complianceService.listForAsset(shipId, assetId);
  }

  @Post('docs')
  @Roles(UserRole.ADMIN)
  createDoc(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Body() body: UpsertComplianceDocInput,
  ) {
    return this.complianceService.createDoc(shipId, body);
  }

  @Patch('docs/:docId')
  @Roles(UserRole.ADMIN)
  updateDoc(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Body() body: Partial<UpsertComplianceDocInput>,
  ) {
    return this.complianceService.updateDoc(shipId, docId, body);
  }

  @Delete('docs/:docId')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteDoc(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ): Promise<void> {
    await this.complianceService.deleteDoc(shipId, docId);
  }

  // ── Link_Model: a document ↔ many assets / crew ──

  @Get('docs/:docId/links')
  listLinks(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ) {
    return this.complianceService.listLinks(shipId, docId);
  }

  @Post('docs/:docId/links')
  @Roles(UserRole.ADMIN)
  addLink(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Body() body: { assetId?: string | null; crewMemberId?: string | null },
  ) {
    return this.complianceService.addLink(shipId, docId, body);
  }

  @Delete('docs/:docId/links/:linkId')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeLink(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
    @Param('linkId', ParseUUIDPipe) linkId: string,
  ): Promise<void> {
    await this.complianceService.removeLink(shipId, docId, linkId);
  }

  @Patch('types/:typeId')
  @Roles(UserRole.ADMIN)
  updateType(
    @Param('shipId', ParseUUIDPipe) shipId: string,
    @Param('typeId', ParseUUIDPipe) typeId: string,
    @Body()
    body: {
      applicability?: string;
      renewalCycle?: string | null;
      surveyWindow?: string | null;
      updateTrigger?: string | null;
      notes?: string | null;
    },
  ) {
    return this.complianceService.updateType(shipId, typeId, body);
  }
}
