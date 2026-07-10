import { formatError } from '../../common/utils/error.utils';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, ILike, Repository } from 'typeorm';
import { UserRole } from '../../common/enums/user-role.enum';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { RagService } from '../../integrations/rag/rag.service';
import { ShipEntity } from '../ships/entities/ship.entity';
import { PLATFORM_SHIP_ID } from '../ships/platform-ship.constants';
import {
  BulkDeleteDocumentsDto,
  BulkDeleteDocumentsResponseDto,
  DocumentDeleteResponseDto,
  DocumentRemoteDeleteStatus,
} from './dto/delete-documents.dto';
import { DocumentListResponseDto } from './dto/document-list-response.dto';
import { DocumentRetrievalResponseDto } from './dto/document-retrieval-response.dto';
import { DocumentResponseDto } from './dto/document-response.dto';
import { ListDocumentsQueryDto } from './dto/list-documents-query.dto';
import { ReparseDocumentDto } from './dto/reparse-document.dto';
import { SearchDocumentsDto } from './dto/search-documents.dto';
import { UpdateDocumentClassificationDto } from './dto/update-document-classification.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { DocumentEntity } from './entities/document.entity';
import { DocumentParseStatus } from './enums/document-parse-status.enum';
import { toDocumentResponse } from './mapping/documents.mapper';
import { DocumentsIngestionService } from './ingestion/documents-ingestion.service';
import { DocumentsUploadStorageService } from './ingestion/documents-upload-storage.service';
import { VisionExtractionService } from './extraction/vision-extraction.service';
import { DocumentDocClass } from './enums/document-doc-class.enum';
import { AssetEntity } from '../assets/entities/asset.entity';
import { AssetDocumentLinkEntity } from '../assets/entities/asset-document-link.entity';
import { DocumentsRemoteIngestionDispatcherService } from './ingestion/documents-remote-ingestion-dispatcher.service';
import { UploadedDocumentFile } from './ingestion/documents-upload.types';
import {
  applyMetadataOverrides,
  applyParsingProfile,
  buildDocumentMetadataFromEntity,
} from './ingestion/documents-profile.helpers';
import {
  buildEffectiveParserConfig,
  getParsingProfileForDocClass,
} from './parsing/document-parsing-profiles';
import { DocumentsRetrievalService } from './retrieval/documents-retrieval.service';

export interface DocumentFilePayload {
  buffer: Buffer;
  contentType: string;
  fileName: string;
}

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipsRepository: Repository<ShipEntity>,
    private readonly documentsIngestionService: DocumentsIngestionService,
    private readonly uploadStorage: DocumentsUploadStorageService,
    @InjectRepository(AssetEntity)
    private readonly assetsRepository: Repository<AssetEntity>,
    @InjectRepository(AssetDocumentLinkEntity)
    private readonly assetDocLinkRepository: Repository<AssetDocumentLinkEntity>,
    private readonly visionExtraction: VisionExtractionService,
    private readonly remoteIngestionDispatcher: DocumentsRemoteIngestionDispatcherService,
    private readonly documentsRetrievalService: DocumentsRetrievalService,
    private readonly ragService: RagService,
  ) {}

  async upload(
    input: UploadDocumentDto,
    file: UploadedDocumentFile,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    const ship = await this.resolveAccessibleShip(input.shipId, user);

    // Asset-register-driven naming: when an asset is provided, the
    // register (brand/model/onboard name) is the source of truth for the
    // document title and metadata — not the uploaded file's name.
    let linkedAsset: AssetEntity | null = null;
    if (input.assetId) {
      linkedAsset = await this.assetsRepository.findOne({
        where: { id: input.assetId, shipId: ship.id },
      });
      if (!linkedAsset) {
        throw new BadRequestException('Asset not found on this ship.');
      }
      const ext = file.originalname?.match(/\.[^.]+$/)?.[0] ?? '.pdf';
      const parts = [
        linkedAsset.brand,
        linkedAsset.model,
      ].filter(Boolean);
      const title = `${parts.join(' ')}${parts.length ? ' — ' : ''}${linkedAsset.displayName}`;
      file = { ...file, originalname: `${title}${ext}` };
      input = {
        ...input,
        manufacturer: input.manufacturer ?? linkedAsset.brand ?? undefined,
        model: input.model ?? linkedAsset.model ?? undefined,
        equipmentName: input.equipmentName ?? linkedAsset.displayName,
      };
    }

    const document = await this.documentsIngestionService.upload(
      input,
      file,
      user,
      ship,
    );

    if (linkedAsset) {
      await this.assetDocLinkRepository.save({
        assetId: linkedAsset.id,
        documentId: document.id,
        linkType: 'pinned',
        createdByUserId: user.id,
      });
    }

    // Text-bearing docs run through the local vision extractor BEFORE RAGFlow
    // sees them: the dispatcher skips pending/running extractions, and once the
    // markdown is attached it uploads the MD instead of the PDF. PLANS are a
    // pure file store (drawings — no useful text extraction), so they skip it.
    if (
      this.visionExtraction.isEnabled() &&
      input.docClass !== DocumentDocClass.PLAN
    ) {
      await this.documentsRepository.update(document.id, {
        extractionStatus: 'pending',
      });
      this.visionExtraction.queue(document.id);
      return document;
    }

    void this.remoteIngestionDispatcher.dispatchPendingRemoteIngestions();
    return document;
  }

  /**
   * Fleet-wide Publications (MARPOL/IMO/rules) are owned by the hidden platform
   * scope row, not a vessel. Admins upload them here without picking a ship; the
   * platform ship id + `publication` class are forced server-side so the file
   * lands in the shared platform RAGFlow dataset. Every vessel's chat sees them
   * via the retrieval union (see DocumentsRetrievalService).
   */
  async uploadPublication(
    input: UploadDocumentDto,
    file: UploadedDocumentFile,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    return this.upload(
      {
        ...input,
        shipId: PLATFORM_SHIP_ID,
        docClass: DocumentDocClass.PUBLICATION,
        assetId: undefined,
      },
      file,
      user,
    );
  }

  async listPublications(
    input: ListDocumentsQueryDto,
    user: AuthenticatedUser,
  ): Promise<DocumentListResponseDto> {
    return this.list(
      {
        ...input,
        shipId: PLATFORM_SHIP_ID,
        docClass: DocumentDocClass.PUBLICATION,
      },
      user,
    );
  }

  async list(
    input: ListDocumentsQueryDto,
    user: AuthenticatedUser,
  ): Promise<DocumentListResponseDto> {
    const shipId = await this.resolveListShipId(input.shipId, user);
    const where: FindOptionsWhere<DocumentEntity> = {};
    const pageSize = input.pageSize ?? 25;
    const requestedPage = input.page ?? 1;

    if (shipId) where.shipId = shipId;
    if (input.docClass) where.docClass = input.docClass;
    if (input.parseStatus) where.parseStatus = input.parseStatus;
    const trimmedName = input.name?.trim();
    if (trimmedName) {
      where.originalFileName = ILike(`%${escapeLikePattern(trimmedName)}%`);
    }

    const total = await this.documentsRepository.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const documents = await this.documentsRepository.find({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    // Linked assets (pinned) per document — the table shows which units a
    // manual is attached to.
    const docIds = documents.map((document) => document.id);
    const linkRows: Array<{ document_id: string; display_name: string }> =
      docIds.length
        ? await this.assetDocLinkRepository.query(
            `SELECT l.document_id, a.display_name
             FROM asset_documents l JOIN assets a ON a.id = l.asset_id
             WHERE l.link_type = 'pinned' AND l.document_id = ANY($1)
             ORDER BY a.display_name`,
            [docIds],
          )
        : [];
    const linksByDoc = new Map<string, string[]>();
    for (const row of linkRows) {
      const list = linksByDoc.get(row.document_id) ?? [];
      list.push(row.display_name);
      linksByDoc.set(row.document_id, list);
    }

    return {
      items: documents.map((document) => ({
        ...toDocumentResponse(document),
        linkedAssets: linksByDoc.get(document.id) ?? [],
      })),
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    };
  }

  async getById(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    return toDocumentResponse(await this.findAccessibleDocument(id, user));
  }

  async updateClassification(
    id: string,
    input: UpdateDocumentClassificationDto,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    const document = await this.findAccessibleDocument(id, user);
    const previousProfile = document.parseProfile;

    if (input.docClass) {
      document.docClass = input.docClass;
      const profile = getParsingProfileForDocClass(input.docClass);
      applyParsingProfile(document, profile);
      document.parserConfigJson = buildEffectiveParserConfig(profile);
    }

    applyMetadataOverrides(document, input);
    document.metadataJson = buildDocumentMetadataFromEntity(document);

    if (document.parseProfile !== previousProfile) {
      document.parseStatus = DocumentParseStatus.REPARSE_REQUIRED;
      document.parseError = null;
      document.parseProgressPercent = null;
    }

    return toDocumentResponse(await this.documentsRepository.save(document));
  }

  async reparse(
    id: string,
    user: AuthenticatedUser,
    input: ReparseDocumentDto = {},
  ): Promise<DocumentResponseDto> {
    const document = await this.findAccessibleDocument(id, user);
    const reparsedDocument = await this.documentsIngestionService.reparse(
      document,
      input,
    );

    void this.remoteIngestionDispatcher.dispatchPendingRemoteIngestions();
    return reparsedDocument;
  }

  async syncStatus(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    const document = await this.findAccessibleDocument(id, user);

    if (!document.ragflowDocumentId) {
      if (
        document.parseStatus === DocumentParseStatus.PENDING_CONFIG ||
        document.parseStatus === DocumentParseStatus.FAILED
      ) {
        return toDocumentResponse(document);
      }

      const queuedDocument =
        await this.documentsIngestionService.prepareRemoteIngestionRetry(document);
      void this.remoteIngestionDispatcher.dispatchPendingRemoteIngestions();
      return toDocumentResponse(queuedDocument);
    }

    return this.documentsIngestionService.syncStatus(document);
  }

  async retryIngestion(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentResponseDto> {
    const document = await this.findAccessibleDocument(id, user);
    const queuedDocument =
      await this.documentsIngestionService.prepareRemoteIngestionRetry(document);

    void this.remoteIngestionDispatcher.dispatchPendingRemoteIngestions();
    return toDocumentResponse(queuedDocument);
  }

  async getFile(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentFilePayload> {
    const document = await this.findAccessibleDocument(id, user);

    // Extracted documents keep their ORIGINAL in storage (local spool or
    // Spaces) — RAGFlow only holds the markdown the AI reads — serve the
    // original here regardless of provider.
    if (
      (this.uploadStorage.isLocalSpoolKey(document.storageKey) ||
        this.uploadStorage.isObjectStorageKey(document.storageKey)) &&
      (await this.uploadStorage.hasUpload(document.storageKey))
    ) {
      return {
        buffer: await this.uploadStorage.readUpload(document.storageKey),
        contentType: document.mimeType || 'application/octet-stream',
        fileName: document.originalFileName,
      };
    }

    if (!document.ragflowDatasetId || !document.ragflowDocumentId) {
      throw new BadRequestException('Document is not uploaded to RAGFlow yet.');
    }

    const remoteFile = await this.ragService.downloadDocumentFromDataset(
      document.ragflowDatasetId,
      document.ragflowDocumentId,
    );

    return {
      buffer: remoteFile.buffer,
      contentType:
        document.mimeType ||
        remoteFile.contentType ||
        'application/octet-stream',
      fileName: document.originalFileName,
    };
  }

  /** Admin-only: raw vision-extracted markdown for review. */
  async getExtractedMarkdown(
    id: string,
    user: AuthenticatedUser,
  ): Promise<{ markdown: string; fileName: string }> {
    const document = await this.findAccessibleDocument(id, user);
    if (!document.extractedMdKey) {
      throw new BadRequestException('No extracted markdown for this document.');
    }
    return {
      markdown: await this.visionExtraction.readExtractedMarkdown(document),
      fileName: document.originalFileName.replace(/\.[^.]+$/, '.md'),
    };
  }

  /** Admin-only: re-run vision extraction (e.g. after extractor fixes). */
  async rerunExtraction(id: string, user: AuthenticatedUser): Promise<void> {
    const document = await this.findAccessibleDocument(id, user);
    if (!this.visionExtraction.isEnabled()) {
      throw new BadRequestException('Vision extractor is not configured.');
    }
    await this.documentsRepository.update(document.id, {
      extractionStatus: 'pending',
      extractionError: null,
    });
    this.visionExtraction.queue(document.id);
  }

  async delete(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentDeleteResponseDto> {
    const document = await this.findAccessibleDocument(id, user);
    return this.deleteDocumentEntity(document);
  }

  async bulkDelete(
    input: BulkDeleteDocumentsDto,
    user: AuthenticatedUser,
  ): Promise<BulkDeleteDocumentsResponseDto> {
    const uniqueIds = Array.from(new Set(input.ids));
    const results: DocumentDeleteResponseDto[] = [];

    for (const id of uniqueIds) {
      try {
        const document = await this.findAccessibleDocument(id, user);
        results.push(await this.deleteDocumentEntity(document));
      } catch (error) {
        results.push({
          id,
          deleted: false,
          remoteDeleteStatus: 'failed',
          error: formatError(error),
        });
      }
    }

    return {
      requested: uniqueIds.length,
      deleted: results.filter((result) => result.deleted).length,
      failed: results.filter((result) => !result.deleted).length,
      results,
    };
  }

  async search(input: SearchDocumentsDto): Promise<DocumentRetrievalResponseDto> {
    return this.documentsRetrievalService.search(input);
  }

  private async deleteDocumentEntity(
    document: DocumentEntity,
  ): Promise<DocumentDeleteResponseDto> {
    let remoteDeleteStatus: DocumentRemoteDeleteStatus = 'skipped';

    if (document.ragflowDatasetId && document.ragflowDocumentId) {
      try {
        await this.ragService.deleteDocumentsFromDataset(document.ragflowDatasetId, [
          document.ragflowDocumentId,
        ]);
        remoteDeleteStatus = 'deleted';
      } catch (error) {
        if (!this.isAcceptableRemoteDeleteMiss(error)) {
          throw new BadGatewayException(
            `RAGFlow document delete failed; local document was not deleted. ${formatError(error)}`,
          );
        }

        remoteDeleteStatus = 'already_absent';
      }
    }

    await this.documentsRepository.delete({ id: document.id });
    await this.documentsIngestionService.deleteLocalUpload(document);

    return {
      id: document.id,
      deleted: true,
      remoteDeleteStatus,
    };
  }

  private isAcceptableRemoteDeleteMiss(error: unknown): boolean {
    const message = formatError(error).toLowerCase();

    return [
      'does not have the document',
      'document not found',
      'documents not found',
      'document was not found',
      'dataset not found',
      'does not own the dataset',
      'lacks permission for dataset',
    ].some((pattern) => message.includes(pattern));
  }


  private async resolveAccessibleShip(
    requestedShipId: string | undefined,
    user: AuthenticatedUser,
  ): Promise<ShipEntity> {
    const shipId = this.resolveShipIdForMutation(requestedShipId, user);
    const ship = await this.shipsRepository.findOne({ where: { id: shipId } });

    if (!ship) {
      throw new NotFoundException('Ship not found');
    }

    return ship;
  }

  private resolveShipIdForMutation(
    requestedShipId: string | undefined,
    user: AuthenticatedUser,
  ): string {
    if (user.role === UserRole.ADMIN) {
      if (!requestedShipId) {
        throw new BadRequestException('shipId is required for admin uploads.');
      }

      return requestedShipId;
    }

    if (!user.shipId) {
      throw new BadRequestException('User is not assigned to a ship.');
    }

    if (requestedShipId && requestedShipId !== user.shipId) {
      throw new NotFoundException('Ship not found');
    }

    return user.shipId;
  }

  private async resolveListShipId(
    requestedShipId: string | undefined,
    user: AuthenticatedUser,
  ): Promise<string | undefined> {
    if (user.role === UserRole.ADMIN) {
      if (!requestedShipId) {
        return undefined;
      }

      const ship = await this.shipsRepository.findOne({
        where: { id: requestedShipId },
      });

      if (!ship) {
        throw new NotFoundException('Ship not found');
      }

      return requestedShipId;
    }

    if (!user.shipId) {
      throw new BadRequestException('User is not assigned to a ship.');
    }

    if (requestedShipId && requestedShipId !== user.shipId) {
      throw new NotFoundException('Ship not found');
    }

    return user.shipId;
  }

  private async findAccessibleDocument(
    id: string,
    user: AuthenticatedUser,
  ): Promise<DocumentEntity> {
    const document = await this.documentsRepository.findOne({ where: { id } });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    if (user.role === UserRole.USER && user.shipId !== document.shipId) {
      throw new NotFoundException('Document not found');
    }

    return document;
  }
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
