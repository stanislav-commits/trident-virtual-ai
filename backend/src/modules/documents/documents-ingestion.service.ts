import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { Repository } from 'typeorm';
import { AuthenticatedUser } from '../../core/auth/auth.types';
import { RagService } from '../../integrations/rag/rag.service';
import type { RagflowDataset } from '../../integrations/rag/ragflow.types';
import { ShipEntity } from '../ships/entities/ship.entity';
import { DocumentResponseDto } from './dto/document-response.dto';
import { UploadDocumentDto } from './dto/upload-document.dto';
import { DocumentEntity } from './entities/document.entity';
import { DocumentParseStatus } from './enums/document-parse-status.enum';
import { DocumentTimeScope } from './enums/document-time-scope.enum';
import { toDocumentResponse } from './documents.mapper';
import { UploadedDocumentFile } from './documents-upload.types';
import { DocumentsUploadStorageService } from './documents-upload-storage.service';
import { DocumentsParseDispatcherService } from './documents-parse-dispatcher.service';
import {
  applyParsingProfile,
  buildDocumentMetadata,
  buildDocumentMetadataFromEntity,
} from './documents-profile.helpers';
import {
  buildEffectiveParserConfig,
  getParsingProfileForDocClass,
} from './parsing/document-parsing-profiles';

@Injectable()
export class DocumentsIngestionService {
  private readonly logger = new Logger(DocumentsIngestionService.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
    @InjectRepository(ShipEntity)
    private readonly shipsRepository: Repository<ShipEntity>,
    private readonly ragService: RagService,
    private readonly parseDispatcher: DocumentsParseDispatcherService,
    private readonly uploadStorage: DocumentsUploadStorageService,
  ) {}

  async upload(
    input: UploadDocumentDto,
    file: UploadedDocumentFile,
    user: AuthenticatedUser,
    ship: ShipEntity,
  ): Promise<DocumentResponseDto> {
    const normalizedFile = this.validateUploadedFile(file);
    const profile = getParsingProfileForDocClass(input.docClass);
    const metadata = buildDocumentMetadata(ship.id, input);

    const document = this.documentsRepository.create({
      shipId: ship.id,
      uploadedByUserId: user.id,
      originalFileName: normalizedFile.originalName,
      storageKey: null,
      mimeType: normalizedFile.mimeType,
      fileSizeBytes: normalizedFile.size,
      checksumSha256: this.sha256(normalizedFile.buffer),
      pageCount: null,
      ragflowDatasetId: ship.ragflowDatasetId ?? null,
      ragflowDocumentId: null,
      docClass: input.docClass,
      language: input.language ?? null,
      equipmentOrSystem: input.equipmentOrSystem ?? null,
      manufacturer: input.manufacturer ?? null,
      model: input.model ?? null,
      revision: input.revision ?? null,
      timeScope: input.timeScope ?? DocumentTimeScope.CURRENT,
      sourcePriority: input.sourcePriority ?? 100,
      contentFocus: input.contentFocus ?? null,
      parseStatus: DocumentParseStatus.UPLOADED,
      parseError: null,
      parseProgressPercent: null,
      chunkCount: null,
      parsedAt: null,
      lastSyncedAt: null,
      metadataJson: metadata,
      parserConfigJson: buildEffectiveParserConfig(profile),
    });
    applyParsingProfile(document, profile);

    const savedDocument = await this.documentsRepository.save(document);
    try {
      savedDocument.storageKey = await this.uploadStorage.saveUpload(
        savedDocument.id,
        normalizedFile.buffer,
      );
      savedDocument.lastSyncedAt = new Date();
      return toDocumentResponse(await this.documentsRepository.save(savedDocument));
    } catch (error) {
      savedDocument.parseStatus = DocumentParseStatus.FAILED;
      savedDocument.parseError = `Local upload staging failed: ${this.formatError(error)}`;
      savedDocument.lastSyncedAt = new Date();
      await this.documentsRepository.save(savedDocument);
      throw new BadRequestException(savedDocument.parseError);
    }
  }

  async ingestRemote(input: DocumentEntity): Promise<void> {
    const document = await this.documentsRepository.findOne({
      where: { id: input.id },
    });

    if (!document) {
      return;
    }

    try {
      document.parseStatus = DocumentParseStatus.PENDING_CONFIG;
      document.parseError = null;
      document.parseProgressPercent = null;
      document.lastSyncedAt = new Date();
      await this.documentsRepository.save(document);

      const ragflowDatasetId = await this.ensureDocumentDataset(document);
      document.ragflowDatasetId = ragflowDatasetId;
      await this.documentsRepository.save(document);

      const localStorageKey = this.uploadStorage.isLocalSpoolKey(
        document.storageKey,
      )
        ? document.storageKey
        : null;

      if (!document.ragflowDocumentId) {
        if (!localStorageKey) {
          throw new Error(
            'Local upload payload is unavailable; upload the document again.',
          );
        }

        const remoteDocument = await this.ragService.uploadDocumentToDataset(
          ragflowDatasetId,
          {
            buffer: await this.uploadStorage.readUpload(localStorageKey),
            originalName: document.originalFileName,
            mimeType: document.mimeType,
          },
        );

        document.ragflowDocumentId = remoteDocument.id;
        document.storageKey = `ragflow://${ragflowDatasetId}/${remoteDocument.id}`;
        document.parseStatus = DocumentParseStatus.PENDING_CONFIG;
        document.parseProgressPercent = null;
        document.lastSyncedAt = new Date();
        await this.documentsRepository.save(document);
        await this.deleteLocalUpload(localStorageKey, document.id);
      }

      if (!document.ragflowDocumentId) {
        throw new Error('RAGFlow did not return a document ID.');
      }

      const profile = getParsingProfileForDocClass(document.docClass);
      await this.ragService.updateRemoteDocumentConfig(
        ragflowDatasetId,
        document.ragflowDocumentId,
        {
          metadata: document.metadataJson ?? buildDocumentMetadataFromEntity(document),
          parsingProfile: profile,
        },
      );

      document.parseStatus = DocumentParseStatus.PENDING_PARSE;
      document.parseProgressPercent = null;
      document.chunkCount = null;
      document.parsedAt = null;
      document.lastSyncedAt = new Date();
      const savedDocument = await this.documentsRepository.save(document);

      await this.parseDispatcher.dispatchPendingParses();
      await this.reloadDocument(savedDocument);
    } catch (error) {
      document.parseStatus = DocumentParseStatus.FAILED;
      document.parseError = this.formatError(error);
      document.parseProgressPercent = null;
      document.lastSyncedAt = new Date();
      await this.documentsRepository.save(document);
      this.logger.warn(
        `RAGFlow upload/config failed for document ${document.id}: ${document.parseError}`,
      );
    }
  }

  async prepareRemoteIngestionRetry(
    document: DocumentEntity,
  ): Promise<DocumentEntity> {
    const freshDocument = await this.reloadDocument(document);

    if (freshDocument.ragflowDocumentId) {
      freshDocument.parseStatus = DocumentParseStatus.PENDING_CONFIG;
      freshDocument.parseError = null;
      freshDocument.parseProgressPercent = null;
      freshDocument.lastSyncedAt = new Date();
      return this.documentsRepository.save(freshDocument);
    }

    if (this.uploadStorage.isLocalSpoolKey(freshDocument.storageKey)) {
      freshDocument.parseStatus = DocumentParseStatus.UPLOADED;
      freshDocument.parseError = null;
      freshDocument.parseProgressPercent = null;
      freshDocument.lastSyncedAt = new Date();
      return this.documentsRepository.save(freshDocument);
    }

    freshDocument.parseStatus = DocumentParseStatus.FAILED;
    freshDocument.parseError =
      'Local upload payload is unavailable; upload the document again.';
    freshDocument.parseProgressPercent = null;
    freshDocument.lastSyncedAt = new Date();
    return this.documentsRepository.save(freshDocument);
  }

  async deleteLocalUpload(document: DocumentEntity): Promise<void>;
  async deleteLocalUpload(storageKey: string, documentId?: string): Promise<void>;
  async deleteLocalUpload(
    input: DocumentEntity | string,
    documentId?: string,
  ): Promise<void> {
    const storageKey = typeof input === 'string' ? input : input.storageKey;

    try {
      await this.uploadStorage.deleteUpload(storageKey);
    } catch (error) {
      this.logger.warn(
        `Failed to delete local upload spool for document ${
          typeof input === 'string' ? documentId ?? 'unknown' : input.id
        }: ${this.formatError(error)}`,
      );
    }
  }

  async reparse(document: DocumentEntity): Promise<DocumentResponseDto> {
    if (!document.ragflowDatasetId || !document.ragflowDocumentId) {
      throw new BadRequestException('Document is not uploaded to RAGFlow yet.');
    }

    const profile = getParsingProfileForDocClass(document.docClass);
    applyParsingProfile(document, profile);
    document.parserConfigJson = buildEffectiveParserConfig(profile);
    document.metadataJson = buildDocumentMetadataFromEntity(document);

    try {
      document.parseStatus = DocumentParseStatus.PENDING_CONFIG;
      document.parseError = null;
      document.parseProgressPercent = null;
      await this.documentsRepository.save(document);

      await this.ragService.updateRemoteDocumentConfig(
        document.ragflowDatasetId,
        document.ragflowDocumentId,
        {
          metadata: document.metadataJson ?? {},
          parsingProfile: profile,
        },
      );

      document.parseStatus = DocumentParseStatus.PENDING_PARSE;
      document.chunkCount = null;
      document.parsedAt = null;
      document.parseProgressPercent = null;
      const savedDocument = await this.documentsRepository.save(document);

      await this.parseDispatcher.dispatchPendingParses();
      return toDocumentResponse(await this.reloadDocument(savedDocument));
    } catch (error) {
      document.parseStatus = DocumentParseStatus.FAILED;
      document.parseError = this.formatError(error);
      document.lastSyncedAt = new Date();
      this.logger.warn(
        `RAGFlow reparse failed for document ${document.id}: ${document.parseError}`,
      );
    }

    return toDocumentResponse(await this.documentsRepository.save(document));
  }

  async syncStatus(document: DocumentEntity): Promise<DocumentResponseDto> {
    if (!document.ragflowDatasetId || !document.ragflowDocumentId) {
      throw new BadRequestException('Document is not uploaded to RAGFlow yet.');
    }

    const remoteDocument = await this.ragService.fetchRemoteDocumentStatus(
      document.ragflowDatasetId,
      document.ragflowDocumentId,
    );

    if (!remoteDocument) {
      document.parseStatus = DocumentParseStatus.FAILED;
      document.parseError = 'RAGFlow document was not found.';
      document.parseProgressPercent = null;
      document.lastSyncedAt = new Date();
      const savedDocument = await this.documentsRepository.save(document);
      await this.parseDispatcher.dispatchPendingParses();
      return toDocumentResponse(await this.reloadDocument(savedDocument));
    }

    this.applyRemoteStatus(document, remoteDocument);
    const savedDocument = await this.documentsRepository.save(document);
    await this.parseDispatcher.dispatchPendingParses();
    return toDocumentResponse(await this.reloadDocument(savedDocument));
  }

  private async ensureShipDataset(ship: ShipEntity): Promise<string> {
    const linkedDataset = await this.findLinkedShipDataset(ship);

    if (linkedDataset) {
      return this.persistShipDatasetLink(ship, linkedDataset.id);
    }

    const datasetName = this.ragService.buildShipDatasetName(ship.id);
    const existingDataset =
      await this.ragService.findAccessibleDatasetByExactName(datasetName);
    const dataset =
      existingDataset ??
      (await this.ragService.createDataset({
        name: datasetName,
        description: `Trident documents for ship ${ship.name}`,
      }));

    return this.persistShipDatasetLink(ship, dataset.id);
  }

  private async ensureDocumentDataset(document: DocumentEntity): Promise<string> {
    const ship = await this.shipsRepository.findOne({
      where: { id: document.shipId },
    });

    if (!ship) {
      throw new NotFoundException('Ship not found');
    }

    return this.ensureShipDataset(ship);
  }

  private async findLinkedShipDataset(
    ship: ShipEntity,
  ): Promise<RagflowDataset | null> {
    if (!ship.ragflowDatasetId) {
      return null;
    }

    const dataset = await this.ragService.findAccessibleDatasetById(
      ship.ragflowDatasetId,
    );

    if (dataset) {
      return dataset;
    }

    this.logger.warn(
      `RAGFlow dataset ${ship.ragflowDatasetId} linked to ship ${ship.id} was not found in accessible datasets; recovering linkage.`,
    );

    return null;
  }

  private async persistShipDatasetLink(
    ship: ShipEntity,
    datasetId: string,
  ): Promise<string> {
    if (ship.ragflowDatasetId !== datasetId) {
      ship.ragflowDatasetId = datasetId;
      await this.shipsRepository.save(ship);
    }

    return datasetId;
  }

  private validateUploadedFile(file: UploadedDocumentFile): {
    buffer: Buffer;
    originalName: string;
    mimeType: string;
    size: number;
  } {
    if (!file?.buffer || !Buffer.isBuffer(file.buffer)) {
      throw new BadRequestException('file is required.');
    }

    const size = file.size ?? file.buffer.length;
    if (size <= 0) {
      throw new BadRequestException('file must not be empty.');
    }

    return {
      buffer: file.buffer,
      originalName: file.originalname?.trim() || 'document',
      mimeType: file.mimetype?.trim() || 'application/octet-stream',
      size,
    };
  }

  private applyRemoteStatus(
    document: DocumentEntity,
    remoteDocument: {
      run?: string;
      progress?: number;
      progress_msg?: string;
      chunk_count?: number;
    },
  ): void {
    const run = String(remoteDocument.run ?? '').toUpperCase();
    const progressPercent =
      this.ragService.getDocumentParseProgressPercent(remoteDocument);
    document.parseProgressPercent = progressPercent;

    if (run === 'DONE' || Number(remoteDocument.progress ?? 0) >= 1) {
      document.parseStatus = DocumentParseStatus.PARSED;
      document.parseError = null;
      document.parseProgressPercent = 100;
      document.parsedAt = document.parsedAt ?? new Date();
    } else if (run === 'RUNNING') {
      document.parseStatus = DocumentParseStatus.PARSING;
    } else if (run === 'FAIL' || run === 'CANCEL') {
      document.parseStatus = DocumentParseStatus.FAILED;
      document.parseError = remoteDocument.progress_msg || 'RAGFlow parsing failed.';
    } else if (
      run === 'UNSTART' &&
      document.parseStatus !== DocumentParseStatus.PARSING
    ) {
      document.parseStatus = DocumentParseStatus.PENDING_PARSE;
    }

    document.chunkCount =
      typeof remoteDocument.chunk_count === 'number'
        ? remoteDocument.chunk_count
        : document.chunkCount;
    document.lastSyncedAt = new Date();
  }

  private sha256(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async reloadDocument(document: DocumentEntity): Promise<DocumentEntity> {
    return (
      (await this.documentsRepository.findOne({ where: { id: document.id } })) ??
      document
    );
  }
}
