import { formatError } from '../../../common/utils/error.utils';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RagService } from '../../../integrations/rag/rag.service';
import { DocumentEntity } from '../entities/document.entity';
import { DocumentParseStatus } from '../enums/document-parse-status.enum';
import { DocumentsParseFallbackService } from './documents-parse-fallback.service';

@Injectable()
export class DocumentsParseStatusSyncService {
  private readonly logger = new Logger(DocumentsParseStatusSyncService.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
    private readonly ragService: RagService,
    private readonly parseFallback: DocumentsParseFallbackService,
  ) {}

  async syncRemoteParseStatus(document: DocumentEntity): Promise<DocumentEntity> {
    if (!document.ragflowDatasetId || !document.ragflowDocumentId) {
      throw new Error('Document is not uploaded to RAGFlow yet.');
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
      return this.documentsRepository.save(document);
    }

    const remoteFailureMessage = this.getRemoteFailureMessage(remoteDocument);

    if (
      remoteFailureMessage &&
      (await this.tryQueueManualParserFallback(document, remoteFailureMessage))
    ) {
      return document;
    }

    this.applyRemoteStatus(document, remoteDocument);
    return this.documentsRepository.save(document);
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
      this.parseFallback.markFallbackSucceeded(document);
    } else if (run === 'RUNNING') {
      document.parseStatus = DocumentParseStatus.PARSING;
    } else if (run === 'FAIL' || run === 'CANCEL') {
      const failureMessage =
        remoteDocument.progress_msg || 'RAGFlow parsing failed.';
      document.parseStatus = DocumentParseStatus.FAILED;
      document.parseError =
        this.parseFallback.formatFailureAfterFallbackIfAttempted(
          document,
          failureMessage,
        );
      this.parseFallback.markFallbackFailed(document, failureMessage);
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

  private getRemoteFailureMessage(remoteDocument: {
    run?: string;
    progress_msg?: string;
  }): string | null {
    const run = String(remoteDocument.run ?? '').toUpperCase();

    if (run !== 'FAIL' && run !== 'CANCEL') {
      return null;
    }

    return remoteDocument.progress_msg || 'RAGFlow parsing failed.';
  }

  private async tryQueueManualParserFallback(
    document: DocumentEntity,
    failureMessage: string,
  ): Promise<boolean> {
    try {
      return await this.parseFallback.queueManualParserFallback(
        document,
        failureMessage,
      );
    } catch (error) {
      this.logger.warn(
        `Manual parser fallback could not be queued for document ` +
          `${document.id}: ${formatError(error)}`,
      );
      return false;
    }
  }

}
