import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { DocumentEntity } from './entities/document.entity';
import { DocumentParseStatus } from './enums/document-parse-status.enum';
import { DocumentsIngestionService } from './documents-ingestion.service';

const DEFAULT_REMOTE_INGESTION_CONCURRENCY = 1;
const DEFAULT_REMOTE_INGESTION_RECOVERY_INTERVAL_MS = 60_000;
const DEFAULT_REMOTE_INGESTION_STALE_MS = 120_000;

@Injectable()
export class DocumentsRemoteIngestionDispatcherService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(
    DocumentsRemoteIngestionDispatcherService.name,
  );
  private dispatchPromise: Promise<void> | null = null;
  private dispatchAgain = false;
  private recoveryTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentsRepository: Repository<DocumentEntity>,
    private readonly configService: ConfigService,
    private readonly documentsIngestionService: DocumentsIngestionService,
  ) {}

  onApplicationBootstrap(): void {
    const intervalMs = this.getRecoveryIntervalMs();

    this.recoveryTimer = setInterval(() => {
      void this.dispatchPendingRemoteIngestions();
    }, intervalMs);
    this.recoveryTimer.unref?.();

    setTimeout(() => {
      void this.dispatchPendingRemoteIngestions();
    }, 1_000).unref?.();
  }

  onApplicationShutdown(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
  }

  async dispatchPendingRemoteIngestions(): Promise<void> {
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
        const processedCount = await this.dispatchPendingRemoteIngestionsOnce();

        if (processedCount > 0) {
          this.dispatchAgain = true;
        }
      } catch (error) {
        this.logger.warn(
          `Document remote ingestion dispatch failed: ${this.formatError(error)}`,
        );
      }
    } while (this.dispatchAgain);
  }

  private async dispatchPendingRemoteIngestionsOnce(): Promise<number> {
    const availableSlots = this.getAvailableSlots();

    if (availableSlots <= 0) {
      return 0;
    }

    const documents = await this.findCandidateDocuments(availableSlots);

    await Promise.all(
      documents.map((document) =>
        this.documentsIngestionService.ingestRemote(document),
      ),
    );

    return documents.length;
  }

  private async findCandidateDocuments(limit: number): Promise<DocumentEntity[]> {
    const staleBefore = new Date(Date.now() - this.getRemoteIngestionStaleMs());

    return this.documentsRepository.find({
      where: [
        {
          parseStatus: DocumentParseStatus.UPLOADED,
        },
        {
          parseStatus: DocumentParseStatus.PENDING_CONFIG,
          updatedAt: LessThan(staleBefore),
        },
      ],
      order: {
        createdAt: 'ASC',
      },
      take: limit,
    });
  }

  private getAvailableSlots(): number {
    return this.getConcurrencyLimit();
  }

  private getConcurrencyLimit(): number {
    return this.getPositiveIntegerConfig(
      'integrations.rag.remoteIngestionConcurrencyLimit',
      DEFAULT_REMOTE_INGESTION_CONCURRENCY,
    );
  }

  private getRecoveryIntervalMs(): number {
    return this.getPositiveIntegerConfig(
      'integrations.rag.remoteIngestionRecoveryIntervalMs',
      DEFAULT_REMOTE_INGESTION_RECOVERY_INTERVAL_MS,
    );
  }

  private getRemoteIngestionStaleMs(): number {
    return this.getPositiveIntegerConfig(
      'integrations.rag.remoteIngestionStaleMs',
      DEFAULT_REMOTE_INGESTION_STALE_MS,
    );
  }

  private getPositiveIntegerConfig(path: string, fallback: number): number {
    const configuredValue = this.configService.get<number>(path, fallback);

    return Number.isInteger(configuredValue) && configuredValue > 0
      ? configuredValue
      : fallback;
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
