import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RagService } from '../../integrations/rag/rag.service';
import { DocumentEntity } from './entities/document.entity';
import { DocumentParseStatus } from './enums/document-parse-status.enum';

@Injectable()
export class DocumentsParseStatusSyncService {
  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
    private readonly ragService: RagService,
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
}
