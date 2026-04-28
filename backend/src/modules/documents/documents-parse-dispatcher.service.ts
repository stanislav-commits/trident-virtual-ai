import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { RagService } from '../../integrations/rag/rag.service';
import { DocumentEntity } from './entities/document.entity';
import { DocumentParseStatus } from './enums/document-parse-status.enum';

const DEFAULT_PARSE_DISPATCH_CONCURRENCY = 2;

@Injectable()
export class DocumentsParseDispatcherService {
  private readonly logger = new Logger(DocumentsParseDispatcherService.name);
  private dispatchPromise: Promise<void> | null = null;
  private dispatchAgain = false;

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
    private readonly configService: ConfigService,
    private readonly ragService: RagService,
  ) {}

  async dispatchPendingParses(): Promise<void> {
    if (this.dispatchPromise) {
      this.dispatchAgain = true;
      return this.dispatchPromise;
    }

    this.dispatchPromise = this.runDispatchLoop();

    try {
      await this.dispatchPromise;
    } finally {
      this.dispatchPromise = null;
    }
  }

  private async runDispatchLoop(): Promise<void> {
    do {
      this.dispatchAgain = false;

      try {
        await this.dispatchPendingParsesOnce();
      } catch (error) {
        this.logger.warn(
          `Document parse dispatch failed: ${this.formatError(error)}`,
        );
      }
    } while (this.dispatchAgain);
  }

  private async dispatchPendingParsesOnce(): Promise<void> {
    const availableSlots = await this.getAvailableSlots();

    if (availableSlots <= 0) {
      return;
    }

    const pendingDocuments = await this.documentsRepository.find({
      where: {
        parseStatus: DocumentParseStatus.PENDING_PARSE,
        ragflowDatasetId: Not(IsNull()),
        ragflowDocumentId: Not(IsNull()),
      },
      order: {
        createdAt: 'ASC',
      },
      take: availableSlots,
    });

    for (const document of pendingDocuments) {
      await this.dispatchDocumentParse(document);
    }
  }

  private async getAvailableSlots(): Promise<number> {
    const activeParseCount = await this.documentsRepository.count({
      where: {
        parseStatus: DocumentParseStatus.PARSING,
      },
    });

    return Math.max(0, this.getConcurrencyLimit() - activeParseCount);
  }

  private getConcurrencyLimit(): number {
    const configuredLimit = this.configService.get<number>(
      'integrations.rag.parseConcurrencyLimit',
      DEFAULT_PARSE_DISPATCH_CONCURRENCY,
    );

    return Number.isInteger(configuredLimit) && configuredLimit > 0
      ? configuredLimit
      : DEFAULT_PARSE_DISPATCH_CONCURRENCY;
  }

  private async dispatchDocumentParse(document: DocumentEntity): Promise<void> {
    if (!document.ragflowDatasetId || !document.ragflowDocumentId) {
      return;
    }

    try {
      await this.ragService.triggerRemoteParse(
        document.ragflowDatasetId,
        document.ragflowDocumentId,
      );

      document.parseStatus = DocumentParseStatus.PARSING;
      document.parseError = null;
      document.parseProgressPercent = null;
      document.lastSyncedAt = new Date();
      await this.documentsRepository.save(document);
    } catch (error) {
      document.parseStatus = DocumentParseStatus.FAILED;
      document.parseError = this.formatError(error);
      document.parseProgressPercent = null;
      document.lastSyncedAt = new Date();
      await this.documentsRepository.save(document);
      this.logger.warn(
        `RAGFlow parse dispatch failed for document ${document.id}: ${document.parseError}`,
      );
    }
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
